package auth

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"
)

func newTestLimiter(t *testing.T, now *time.Time, attempts int) *RateLimiter {
	t.Helper()
	limiter, err := NewRateLimiter(Config{
		MaxAttempts: attempts,
		Lockout:     10 * time.Minute,
		ResetWindow: time.Hour,
		Now:         func() time.Time { return *now },
	})
	if err != nil {
		t.Fatal(err)
	}
	return limiter
}

func TestRateLimiterLifecycle(t *testing.T) {
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	limiter := newTestLimiter(t, &now, 3)
	ctx := context.Background()

	result, err := limiter.CheckLimit(ctx, "203.0.113.1")
	if err != nil || !result.Allowed || result.AttemptsRemaining != 3 {
		t.Fatalf("unexpected initial decision: %#v, %v", result, err)
	}
	for i := 0; i < 3; i++ {
		if err := limiter.RecordFailure(ctx, "203.0.113.1"); err != nil {
			t.Fatal(err)
		}
	}
	result, err = limiter.CheckLimit(ctx, "203.0.113.1")
	if err != nil || result.Allowed || result.AttemptsRemaining != 0 ||
		result.LockoutExpiresAt == nil || !result.LockoutExpiresAt.Equal(now.Add(10*time.Minute)) {
		t.Fatalf("unexpected locked decision: %#v, %v", result, err)
	}

	now = now.Add(10 * time.Minute)
	result, err = limiter.CheckLimit(ctx, "203.0.113.1")
	if err != nil || !result.Allowed || result.AttemptsRemaining != 3 {
		t.Fatalf("lockout did not expire: %#v, %v", result, err)
	}
}

func TestResetWindowAndSuccessClearState(t *testing.T) {
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	limiter := newTestLimiter(t, &now, 5)
	ctx := context.Background()
	if err := limiter.RecordFailure(ctx, "client"); err != nil {
		t.Fatal(err)
	}
	if err := limiter.RecordSuccess(ctx, "client"); err != nil {
		t.Fatal(err)
	}
	result, _ := limiter.CheckLimit(ctx, "client")
	if result.AttemptsRemaining != 5 {
		t.Fatalf("success did not clear state: %#v", result)
	}

	if err := limiter.RecordFailure(ctx, "client"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	result, _ = limiter.CheckLimit(ctx, "client")
	if result.AttemptsRemaining != 5 {
		t.Fatalf("reset window did not clear state: %#v", result)
	}
}

func TestConcurrentFailuresAreNotLost(t *testing.T) {
	now := time.Date(2026, 7, 24, 0, 0, 0, 0, time.UTC)
	const failures = 100
	limiter := newTestLimiter(t, &now, failures+1)
	var wait sync.WaitGroup
	wait.Add(failures)
	for i := 0; i < failures; i++ {
		go func() {
			defer wait.Done()
			if err := limiter.RecordFailure(context.Background(), "shared"); err != nil {
				t.Errorf("RecordFailure: %v", err)
			}
		}()
	}
	wait.Wait()
	result, err := limiter.CheckLimit(context.Background(), "shared")
	if err != nil || result.AttemptsRemaining != 1 {
		t.Fatalf("lost concurrent updates: %#v, %v", result, err)
	}
}

func TestConfigAndInputValidation(t *testing.T) {
	cases := []Config{
		{},
		{MaxAttempts: 1},
		{MaxAttempts: 1, Lockout: time.Second},
		{MaxAttempts: 1, Lockout: 2 * time.Second, ResetWindow: time.Second},
	}
	for _, config := range cases {
		if _, err := NewRateLimiter(config); err == nil {
			t.Fatalf("accepted invalid config: %#v", config)
		}
	}
	now := time.Now()
	limiter := newTestLimiter(t, &now, 1)
	for _, clientID := range []string{"", " ", string(make([]byte, 256))} {
		if _, err := limiter.CheckLimit(context.Background(), clientID); err == nil {
			t.Fatalf("accepted invalid client identifier of length %d", len(clientID))
		}
	}
}

func TestStorageHonorsCancelledContext(t *testing.T) {
	storage := NewInMemoryStorage()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := storage.Update(ctx, "key", func(*RateLimitState) (*RateLimitState, error) {
		t.Fatal("callback must not run")
		return nil, nil
	}); err != context.Canceled {
		t.Fatalf("got %v, want context.Canceled", err)
	}
}

func TestExtractClientIP(t *testing.T) {
	tests := []struct {
		name    string
		remote  string
		headers http.Header
		trusted []string
		want    string
		wantErr bool
	}{
		{"direct ignores spoofed header", "198.51.100.4:1234", http.Header{"X-Forwarded-For": {"1.2.3.4"}}, nil, "198.51.100.4", false},
		{"trusted proxy chain", "10.0.0.2:443", http.Header{"X-Forwarded-For": {"203.0.113.8, 10.0.0.1"}}, []string{"10.0.0.0/8"}, "203.0.113.8", false},
		{"spoofed cloudflare ignored", "10.0.0.2:443", http.Header{"Cf-Connecting-Ip": {"203.0.113.9"}}, []string{"10.0.0.0/8"}, "10.0.0.2", false},
		{"trusted peer without forwarding", "10.0.0.2:443", nil, []string{"10.0.0.0/8"}, "10.0.0.2", false},
		{"malformed forwarded header", "10.0.0.2:443", http.Header{"X-Forwarded-For": {"bad"}}, []string{"10.0.0.0/8"}, "", true},
		{"malformed peer", "bad", nil, nil, "", true},
		{"malformed CIDR", "10.0.0.2:443", nil, []string{"bad"}, "", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := ExtractClientIP(test.remote, test.headers, test.trusted)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v", err)
			}
			if err == nil && got.String() != test.want {
				t.Fatalf("got %q, want %q", got, test.want)
			}
		})
	}
}

func TestHashIP(t *testing.T) {
	secret := "01234567890123456789012345678901"
	first, err := HashIP("203.0.113.1", secret)
	if err != nil {
		t.Fatal(err)
	}
	second, _ := HashIP("203.0.113.1", secret)
	if first != second || len(first) != 64 {
		t.Fatalf("unexpected digest %q", first)
	}
	if _, err := HashIP("invalid", secret); err == nil {
		t.Fatal("accepted invalid IP")
	}
	if _, err := HashIP("203.0.113.1", "short"); err == nil {
		t.Fatal("accepted short secret")
	}
	expanded, err := HashIP("2001:0db8:0000:0000:0000:0000:0000:0001", secret)
	if err != nil {
		t.Fatal(err)
	}
	compressed, err := HashIP("2001:db8::1", secret)
	if err != nil {
		t.Fatal(err)
	}
	if expanded != compressed {
		t.Fatal("equivalent IPv6 forms produced different digests")
	}
}
