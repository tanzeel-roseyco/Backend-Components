package auth

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

const keyPrefix = "rate_limit:"

// RateLimitState is the durable state stored for one client identifier.
type RateLimitState struct {
	Attempts    int
	RecordedAt  time.Time
	LockedUntil time.Time
}

// RateLimitResult is a snapshot of the current decision.
type RateLimitResult struct {
	Allowed           bool
	AttemptsRemaining int
	LockoutExpiresAt  *time.Time
}

// RateLimiterStorage atomically reads and optionally replaces one record.
// Implementations must serialize concurrent Update calls for the same key.
type RateLimiterStorage interface {
	Update(ctx context.Context, key string, change func(*RateLimitState) (*RateLimitState, error)) error
}

// InMemoryStorage is concurrency-safe, process-local storage.
type InMemoryStorage struct {
	mu    sync.Mutex
	store map[string]RateLimitState
}

func NewInMemoryStorage() *InMemoryStorage {
	return &InMemoryStorage{store: make(map[string]RateLimitState)}
}

func (s *InMemoryStorage) Update(
	ctx context.Context,
	key string,
	change func(*RateLimitState) (*RateLimitState, error),
) error {
	if err := ctx.Err(); err != nil {
		return err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	var current *RateLimitState
	if value, ok := s.store[key]; ok {
		copy := value
		current = &copy
	}
	next, err := change(current)
	if err != nil {
		return err
	}
	if next == nil {
		delete(s.store, key)
		return nil
	}
	s.store[key] = *next
	return nil
}

type Config struct {
	MaxAttempts int
	Lockout     time.Duration
	ResetWindow time.Duration
	Storage     RateLimiterStorage
	Now         func() time.Time
}

type RateLimiter struct {
	maxAttempts int
	lockout     time.Duration
	resetWindow time.Duration
	storage     RateLimiterStorage
	now         func() time.Time
}

func NewRateLimiter(config Config) (*RateLimiter, error) {
	if config.MaxAttempts <= 0 {
		return nil, errors.New("max attempts must be positive")
	}
	if config.Lockout <= 0 {
		return nil, errors.New("lockout duration must be positive")
	}
	if config.ResetWindow <= 0 {
		return nil, errors.New("reset window must be positive")
	}
	if config.ResetWindow < config.Lockout {
		return nil, errors.New("reset window must be greater than or equal to lockout duration")
	}
	if config.Storage == nil {
		config.Storage = NewInMemoryStorage()
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	return &RateLimiter{
		maxAttempts: config.MaxAttempts,
		lockout:     config.Lockout, resetWindow: config.ResetWindow,
		storage: config.Storage, now: config.Now,
	}, nil
}

func (rl *RateLimiter) CheckLimit(ctx context.Context, clientID string) (RateLimitResult, error) {
	if err := validateClientID(clientID); err != nil {
		return RateLimitResult{}, err
	}
	now := rl.now()
	result := RateLimitResult{Allowed: true, AttemptsRemaining: rl.maxAttempts}
	err := rl.storage.Update(ctx, keyPrefix+clientID, func(state *RateLimitState) (*RateLimitState, error) {
		if state == nil || !now.Before(state.RecordedAt.Add(rl.resetWindow)) {
			return nil, nil
		}
		if now.Before(state.LockedUntil) {
			expires := state.LockedUntil
			result = RateLimitResult{Allowed: false, LockoutExpiresAt: &expires}
			return state, nil
		}
		if !state.LockedUntil.IsZero() {
			return nil, nil
		}
		result.AttemptsRemaining = max(0, rl.maxAttempts-state.Attempts)
		result.Allowed = result.AttemptsRemaining > 0
		return state, nil
	})
	return result, err
}

func (rl *RateLimiter) RecordFailure(ctx context.Context, clientID string) error {
	if err := validateClientID(clientID); err != nil {
		return err
	}
	now := rl.now()
	return rl.storage.Update(ctx, keyPrefix+clientID, func(state *RateLimitState) (*RateLimitState, error) {
		if state == nil || !now.Before(state.RecordedAt.Add(rl.resetWindow)) {
			state = &RateLimitState{RecordedAt: now}
		}
		state.Attempts++
		if state.Attempts >= rl.maxAttempts {
			state.LockedUntil = now.Add(rl.lockout)
		}
		return state, nil
	})
}

func (rl *RateLimiter) RecordSuccess(ctx context.Context, clientID string) error {
	return rl.Reset(ctx, clientID)
}

func (rl *RateLimiter) Reset(ctx context.Context, clientID string) error {
	if err := validateClientID(clientID); err != nil {
		return err
	}
	return rl.storage.Update(ctx, keyPrefix+clientID, func(*RateLimitState) (*RateLimitState, error) {
		return nil, nil
	})
}

func validateClientID(clientID string) error {
	if strings.TrimSpace(clientID) == "" {
		return errors.New("client identifier must not be empty")
	}
	if len(clientID) > 255 {
		return errors.New("client identifier exceeds 255 bytes")
	}
	return nil
}

// ExtractClientIP uses forwarding headers only when the immediate peer is in trustedProxyCIDRs.
func ExtractClientIP(remoteAddr string, headers http.Header, trustedProxyCIDRs []string) (net.IP, error) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	peer := net.ParseIP(strings.TrimSpace(host))
	if peer == nil {
		return nil, fmt.Errorf("invalid remote address %q", remoteAddr)
	}
	trusted, err := parseCIDRs(trustedProxyCIDRs)
	if err != nil {
		return nil, err
	}
	if !containsIP(trusted, peer) {
		return peer, nil
	}

	forwarded := strings.TrimSpace(headers.Get("X-Forwarded-For"))
	if forwarded == "" {
		return peer, nil
	}
	parts := strings.Split(forwarded, ",")
	for i := len(parts) - 1; i >= 0; i-- {
		ip := net.ParseIP(strings.TrimSpace(parts[i]))
		if ip == nil {
			return nil, errors.New("invalid X-Forwarded-For header")
		}
		if !containsIP(trusted, ip) {
			return ip, nil
		}
	}
	return peer, nil
}

func parseCIDRs(values []string) ([]*net.IPNet, error) {
	networks := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			return nil, fmt.Errorf("invalid trusted proxy CIDR %q: %w", value, err)
		}
		networks = append(networks, network)
	}
	return networks, nil
}

func containsIP(networks []*net.IPNet, ip net.IP) bool {
	for _, network := range networks {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

// HashIP returns a keyed digest suitable for correlating an IP without storing it in logs.
func HashIP(ip, secret string) (string, error) {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return "", errors.New("invalid IP address")
	}
	if len(secret) < 32 {
		return "", errors.New("hash secret must be at least 32 bytes")
	}
	hash := hmac.New(sha256.New, []byte(secret))
	_, _ = hash.Write([]byte(parsed.String()))
	return hex.EncodeToString(hash.Sum(nil)), nil
}
