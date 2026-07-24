#!/usr/bin/env sh
set -eu

container="backend-components-postgres-$$"
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --name "$container" -d \
  -e POSTGRES_PASSWORD=postgres \
  -v "$(pwd)/shared/sql:/workspace:ro" \
  supabase/postgres:15.8.1.085 >/dev/null

attempt=0
until docker exec "$container" pg_isready -U postgres >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker logs "$container"
    exit 1
  fi
  sleep 1
done

# The Supabase image does not consistently grant its limited postgres role
# permission to assume authenticated in CI. Its admin role owns role setup.
docker exec -e PGPASSWORD=postgres "$container" \
  psql -v ON_ERROR_STOP=1 -U supabase_admin -d postgres \
  -c "create extension if not exists pgtap" \
  -f /workspace/tenant-rls-reference.sql \
  -f /workspace/tenant-rls-reference.pgtap.sql \
  -f /workspace/tenant-rls-reference.down.sql \
  -f /workspace/tenant-rls-reference.down.sql
