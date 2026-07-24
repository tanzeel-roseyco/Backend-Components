# Go component

`auth/rate_limiter.go` is the only Go component in this repository. It tracks
authentication attempts through a storage interface and returns lockout state
to its caller.

The repository does not contain a `go.mod`, so the directory is not currently a
standalone Go module and `go get` against this path is not a supported install
method. Copy the file into an existing module, implement or use the storage
required by the source, and add tests in that module.

See `auth/rate_limiter.README.md` for the component contract and limits.
