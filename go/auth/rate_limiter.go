package auth

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"
)

// RateLimitResult represents the result of a rate limit check
type RateLimitResult struct {
	Allowed            bool
	AttemptsRemaining  int
	LockoutExpiresAt   *time.Time
}

// RateLimiterStorage defines the interface for storing rate limit data
type RateLimiterStorage interface {
	Get(ctx context.Context, key string) (map[string]interface{}, error)
	Set(ctx context.Context, key string, value map[string]interface{}) error
	Delete(ctx context.Context, key string) error
}

// InMemoryStorage is a basic in-memory storage implementation
type InMemoryStorage struct {
	store map[string]map[string]interface{}
}

// NewInMemoryStorage creates a new in-memory storage
func NewInMemoryStorage() *InMemoryStorage {
	return &InMemoryStorage{
		store: make(map[string]map[string]interface{}),
	}
}

func (s *InMemoryStorage) Get(ctx context.Context, key string) (map[string]interface{}, error) {
	if val, ok := s.store[key]; ok {
		return val, nil
	}
	return nil, nil
}

func (s *InMemoryStorage) Set(ctx context.Context, key string, value map[string]interface{}) error {
	s.store[key] = value
	return nil
}

func (s *InMemoryStorage) Delete(ctx context.Context, key string) error {
	delete(s.store, key)
	return nil
}

// RateLimiter implements IP-based rate limiting
type RateLimiter struct {
	MaxAttempts    int
	LockoutMinutes int
	ResetHours     int
	storage        RateLimiterStorage
}

// NewRateLimiter creates a new rate limiter
func NewRateLimiter(maxAttempts, lockoutMinutes, resetHours int, storage RateLimiterStorage) *RateLimiter {
	if storage == nil {
		storage = NewInMemoryStorage()
	}
	return &RateLimiter{
		MaxAttempts:    maxAttempts,
		LockoutMinutes: lockoutMinutes,
		ResetHours:     resetHours,
		storage:        storage,
	}
}

// CheckLimit checks if an IP is rate limited
func (rl *RateLimiter) CheckLimit(ctx context.Context, ipAddress string) (*RateLimitResult, error) {
	key := fmt.Sprintf("rate_limit:%s", ipAddress)
	now := time.Now()

	existing, err := rl.storage.Get(ctx, key)
	if err != nil {
		return nil, err
	}

	// No record = first attempt
	if existing == nil {
		return &RateLimitResult{
			Allowed:           true,
			AttemptsRemaining: rl.MaxAttempts - 1,
		}, nil
	}

	// Check if locked out
	if lockedUntil, ok := existing["locked_until"].(time.Time); ok {
		if lockedUntil.After(now) {
			return &RateLimitResult{
				Allowed:           false,
				AttemptsRemaining: 0,
				LockoutExpiresAt:  &lockedUntil,
			}, nil
		}
	}

	// Check if reset window has passed
	if recordTime, ok := existing["recorded_at"].(time.Time); ok {
		resetDuration := time.Duration(rl.ResetHours) * time.Hour
		if now.After(recordTime.Add(resetDuration)) {
			// Reset counter
			return &RateLimitResult{
				Allowed:           true,
				AttemptsRemaining: rl.MaxAttempts - 1,
			}, nil
		}
	}

	// Within tracking window
	attempts := 0
	if a, ok := existing["attempts"].(int); ok {
		attempts = a
	}

	return &RateLimitResult{
		Allowed:           attempts < rl.MaxAttempts,
		AttemptsRemaining: max(0, rl.MaxAttempts-attempts),
	}, nil
}

// RecordFailure records a failed login attempt
func (rl *RateLimiter) RecordFailure(ctx context.Context, ipAddress string) error {
	key := fmt.Sprintf("rate_limit:%s", ipAddress)
	now := time.Now()

	existing, err := rl.storage.Get(ctx, key)
	if err != nil {
		return err
	}

	attempts := 0
	if existing != nil {
		if a, ok := existing["attempts"].(int); ok {
			attempts = a
		}
	}

	attempts++
	lockedUntil := now.Add(time.Duration(rl.LockoutMinutes) * time.Minute)

	return rl.storage.Set(ctx, key, map[string]interface{}{
		"attempts":      attempts,
		"locked_until":  lockedUntil,
		"recorded_at":   now,
	})
}

// RecordSuccess records a successful login (resets counter)
func (rl *RateLimiter) RecordSuccess(ctx context.Context, ipAddress string) error {
	key := fmt.Sprintf("rate_limit:%s", ipAddress)
	return rl.storage.Delete(ctx, key)
}

// Reset manually resets rate limit for an IP (admin action)
func (rl *RateLimiter) Reset(ctx context.Context, ipAddress string) error {
	key := fmt.Sprintf("rate_limit:%s", ipAddress)
	return rl.storage.Delete(ctx, key)
}

// ExtractClientIP extracts client IP from request headers
func ExtractClientIP(headers map[string]string) string {
	// Check CloudFlare
	if cfIP, ok := headers["CF-Connecting-IP"]; ok {
		return cfIP
	}

	// Check X-Forwarded-For
	if forwardedFor, ok := headers["X-Forwarded-For"]; ok {
		// Take the last IP (rightmost trusted proxy)
		return forwardedFor
	}

	// Direct connection
	return "0.0.0.0"
}

// Helper function
func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

// Hash helper for logging (PII protection)
func HashIP(ip string) string {
	hash := sha256.Sum256([]byte(ip))
	return hex.EncodeToString(hash[:])
}
