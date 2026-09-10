#!/usr/bin/env bash
# Only new task-owned containers/databases and private artifacts are used. No
# docker-compose, project DSNs, existing volumes, or checkout/branch changes.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${CONTENT_AUDIT_RELEASE_TAG:?Set to the latest published release tag to verify the upgrade baseline}"
git rev-parse --verify "refs/tags/$CONTENT_AUDIT_RELEASE_TAG^{commit}" >/dev/null
release_commit=$(git rev-parse "refs/tags/$CONTENT_AUDIT_RELEASE_TAG^{commit}")
work=$(mktemp -d "${CONTENT_AUDIT_TEST_ARTIFACT_DIR:-${TMPDIR:-/tmp}}/content-audit-matrix-XXXXXX")
export GOCACHE="${GOCACHE:-$work/gocache}" GOTMPDIR="${GOTMPDIR:-$work/gotmp}"
mkdir -p "$GOCACHE" "$GOTMPDIR" "$work/release"
printf 'ARTIFACTS=%s\nRELEASE=%s %s\nGOCACHE=%s\nGOTMPDIR=%s\n' "$work" "$CONTENT_AUDIT_RELEASE_TAG" "$release_commit" "$GOCACHE" "$GOTMPDIR"
run="content-audit-ephemeral-$(date +%s)-$$"
owned=("$run-pg" "$run-mysql" "$run-ch")
cleanup() {
  for container in "${owned[@]}"; do
    if [[ "$(docker inspect --format '{{index .Config.Labels "new-api.content-audit-test"}}' "$container" 2>/dev/null || true)" == "$run" ]]; then
      docker rm -fv "$container" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for image in postgres:16-alpine mysql:8.0 clickhouse/clickhouse-server:25.8; do
  docker image inspect "$image" --format '{{.RepoTags}} {{.Id}}'
done

docker run --rm -d --name "$run-pg" --label "new-api.content-audit-test=$run" -p 127.0.0.1::5432 \
  -e POSTGRES_DB=content_audit_ephemeral -e POSTGRES_USER=audit_test \
  -e POSTGRES_PASSWORD=ephemeral-audit-only postgres:16-alpine >/dev/null
docker run --rm -d --name "$run-mysql" --label "new-api.content-audit-test=$run" -p 127.0.0.1::3306 \
  -e MYSQL_DATABASE=content_audit_ephemeral -e MYSQL_ROOT_PASSWORD=ephemeral-audit-only \
  mysql:8.0 >/dev/null
docker run --rm -d --name "$run-ch" --label "new-api.content-audit-test=$run" -p 127.0.0.1::9000 \
  -e CLICKHOUSE_DB=content_audit_ephemeral -e CLICKHOUSE_USER=audit_test \
  -e CLICKHOUSE_PASSWORD=ephemeral-audit-only -e CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1 \
  clickhouse/clickhouse-server:25.8 >/dev/null

ready=false
for ((attempt=0; attempt<120; attempt++)); do
  if docker exec "$run-pg" pg_isready -U audit_test -d content_audit_ephemeral >/dev/null 2>&1 && \
     docker exec "$run-mysql" mysqladmin ping -h 127.0.0.1 -uroot -pephemeral-audit-only --silent >/dev/null 2>&1 && \
     docker exec "$run-ch" clickhouse-client --user audit_test --password ephemeral-audit-only --query 'SELECT 1' >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  echo 'Ephemeral database readiness failed; no existing services were used.' >&2
  exit 1
fi

pg_port=$(docker port "$run-pg" 5432/tcp | awk -F: '{print $NF}')
mysql_port=$(docker port "$run-mysql" 3306/tcp | awk -F: '{print $NF}')
ch_port=$(docker port "$run-ch" 9000/tcp | awk -F: '{print $NF}')
export CONTENT_AUDIT_TEST_POSTGRES_DSN="postgres://audit_test:ephemeral-audit-only@127.0.0.1:$pg_port/content_audit_ephemeral?sslmode=disable"
export CONTENT_AUDIT_TEST_MYSQL_DSN="root:ephemeral-audit-only@tcp(127.0.0.1:$mysql_port)/content_audit_ephemeral?charset=utf8mb4&parseTime=True&loc=UTC"
export CONTENT_AUDIT_TEST_CLICKHOUSE_DSN="clickhouse://audit_test:ephemeral-audit-only@127.0.0.1:$ch_port/content_audit_ephemeral"

docker exec "$run-pg" psql -U audit_test -d content_audit_ephemeral -Atc 'SELECT version()'
docker exec "$run-mysql" mysql -uroot -pephemeral-audit-only -Nse 'SELECT VERSION()' 2>/dev/null
docker exec "$run-ch" clickhouse-client --user audit_test --password ephemeral-audit-only --query 'SELECT version()'
go version

# Build the real released migration code in an archived source tree. The small
# executable invokes the same full InitDB/InitLogDB paths as server startup;
# it never starts schedulers, provider polling, or an HTTP deployment.
git archive "refs/tags/$CONTENT_AUDIT_RELEASE_TAG" | tar -x -C "$work/release"
mkdir "$work/release/content-audit-baseline"
cat > "$work/release/content-audit-baseline/main.go" <<'GO'
package main

import (
 "fmt"
 "os"
 "slices"
 "strings"
 "github.com/QuantumNous/new-api/common"
 "github.com/QuantumNous/new-api/model"
 "gorm.io/gorm"
 "gorm.io/gorm/logger"
)

type schema struct { Rows map[string]int64 `json:"rows"`; Indexes map[string][]string `json:"indexes"`; ClickHouseDDL string `json:"clickhouse_ddl"` }
func snapshot(db *gorm.DB, clickhouse bool) schema {
 s := schema{Rows: map[string]int64{}, Indexes: map[string][]string{}}
 db = db.Session(&gorm.Session{Logger:logger.Discard})
 var tables []string
 if clickhouse { must(db.Raw("SHOW TABLES").Scan(&tables).Error) } else { var err error; tables, err = db.Migrator().GetTables(); must(err) }
 for _, table := range tables {
  if strings.HasPrefix(table, "sqlite_") { continue }
  var count int64; must(db.Table(table).Count(&count).Error); s.Rows[table] = count
  if clickhouse { continue }
  indexes, err := db.Migrator().GetIndexes(table); must(err)
  values := []string{}
  for _, index := range indexes { unique, _ := index.Unique(); primary, _ := index.PrimaryKey(); values = append(values, fmt.Sprintf("%s|%t|%t|%s", index.Name(), unique, primary, strings.Join(index.Columns(), ","))) }
  slices.Sort(values); s.Indexes[table] = values
 }
 if clickhouse { must(db.Raw("SHOW CREATE TABLE audit_logs").Scan(&s.ClickHouseDDL).Error) }
 return s
}
func must(err error) { if err != nil { panic(err) } }
func main() {
 for _, key := range []string{"SQL_DSN", "LOG_SQL_DSN"} {
  value := os.Getenv(key)
  if value != "local" && !strings.Contains(value, "content_audit_ephemeral") { panic("refusing non-ephemeral DSN") }
 }
 common.SQLitePath = os.Getenv("CONTENT_AUDIT_STARTUP_SQLITE")
 common.IsMasterNode = true
 must(model.InitDB()); must(model.InitLogDB()); defer model.CloseDB()
 if os.Getenv("CONTENT_AUDIT_BASELINE_SEED") == "true" {
  user := model.User{Username:"content-audit-released-user", Password:"not-a-login-hash", Role:common.RoleRootUser, Status:common.UserStatusEnabled, AuthVersion:1, Quota:9876543210, UsedQuota:4321, AffCode:"audit-release", Group:"default"}
  must(model.DB.Create(&user).Error)
  must(model.DB.Create(&model.UserSession{SID:"audit-released-session", UserID:user.Id, Version:1, UserAuthVersion:1, Status:model.UserSessionStatusActive, RefreshHash:"fixture-not-a-token", ExpiresAt:2000000000}).Error)
  must(model.DB.Create(&model.Token{UserId:user.Id, Key:"audit-released-token", Status:common.TokenStatusEnabled, Name:"released token", RemainQuota:123456, Group:"default"}).Error)
  must(model.DB.Create(&model.Channel{Name:"released channel", Type:1, Key:"fixture-not-a-provider-key", Status:common.ChannelStatusEnabled, Models:"gpt-4o-mini", Group:"default"}).Error)
  must(model.DB.Create(&model.Option{Key:"content-audit-baseline-preserved", Value:"released-value"}).Error)
  model.RecordAuditLog(nil, model.AuditLog{EventId:"content-audit-release-event", RequestId:"content-audit-release-request", UserId:user.Id, Username:user.Username, ActorRole:common.RoleRootUser, Category:model.AuditCategorySecurity, Action:"release.fixture", Success:true, Other:model.AuditOther{RootInfo:model.AuditFields{"baseline":"preserve"}}})
 }
 output := map[string]schema{"main":snapshot(model.DB,false), "log":snapshot(model.LOG_DB,common.UsingLogDatabase(common.DatabaseTypeClickHouse))}
 data, err := common.Marshal(output); must(err)
 must(os.WriteFile(os.Getenv("CONTENT_AUDIT_BASELINE_MANIFEST"), data, 0600))
 fmt.Printf("released full startup/migration passed; primary=%s log=%s\n", common.MainDatabaseType(), common.LogDatabaseType())
}
GO
(cd "$work/release" && go build -o "$work/released-migrate" ./content-audit-baseline)

for database in content_audit_ephemeral_fresh content_audit_ephemeral_upgrade content_audit_ephemeral_fresh_log content_audit_ephemeral_upgrade_log; do
  docker exec "$run-pg" createdb -U audit_test "$database"
  docker exec "$run-mysql" mysql -uroot -pephemeral-audit-only -e "CREATE DATABASE $database CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci" 2>/dev/null
  docker exec "$run-ch" clickhouse-client --user audit_test --password ephemeral-audit-only --query "CREATE DATABASE $database"
done

for dialect in sqlite mysql postgres clickhouse; do
  for scenario in fresh upgrade; do
    export CONTENT_AUDIT_STARTUP_DIALECT="$dialect" CONTENT_AUDIT_STARTUP_SCENARIO="$scenario"
    export CONTENT_AUDIT_STARTUP_SQLITE="$work/content_audit_ephemeral_${dialect}_${scenario}.db"
    export CONTENT_AUDIT_STARTUP_LOG_SQLITE="$work/content_audit_ephemeral_${dialect}_${scenario}_log.db"
    export CONTENT_AUDIT_BASELINE_MANIFEST="$work/${dialect}-released-schema.json"
    export CONTENT_AUDIT_BASELINE_COMMIT="$release_commit"
    name="content_audit_ephemeral_$scenario"
    case "$dialect" in
      sqlite)
        export CONTENT_AUDIT_STARTUP_DSN=local CONTENT_AUDIT_STARTUP_LOG_DSN=local
        ;;
      mysql)
        export CONTENT_AUDIT_STARTUP_DSN="root:ephemeral-audit-only@tcp(127.0.0.1:$mysql_port)/$name?charset=utf8mb4&parseTime=True&loc=UTC"
        export CONTENT_AUDIT_STARTUP_LOG_DSN="root:ephemeral-audit-only@tcp(127.0.0.1:$mysql_port)/${name}_log?charset=utf8mb4&parseTime=True&loc=UTC"
        ;;
      postgres)
        export CONTENT_AUDIT_STARTUP_DSN="postgres://audit_test:ephemeral-audit-only@127.0.0.1:$pg_port/$name?sslmode=disable"
        export CONTENT_AUDIT_STARTUP_LOG_DSN="postgres://audit_test:ephemeral-audit-only@127.0.0.1:$pg_port/${name}_log?sslmode=disable"
        ;;
      clickhouse)
        export CONTENT_AUDIT_STARTUP_DSN=local
        export CONTENT_AUDIT_STARTUP_LOG_DSN="clickhouse://audit_test:ephemeral-audit-only@127.0.0.1:$ch_port/${name}_log"
        ;;
    esac
    if [[ "$scenario" == upgrade ]]; then
      for seed in true false; do
        # SQLite's startup API uses the same configurable SQLitePath for both
        # connections; its independently configured LOG_DB is also covered by
        # TestContentAuditLogDatabaseMatrix below with a different SQLite file.
        SQL_DSN="$CONTENT_AUDIT_STARTUP_DSN" LOG_SQL_DSN="$CONTENT_AUDIT_STARTUP_LOG_DSN" \
          CONTENT_AUDIT_BASELINE_SEED="$seed" "$work/released-migrate" 2>&1 | tee "$work/$dialect-release-$seed.log"
      done
    fi
    go test ./service -run '^TestContentAuditStartupMatrix$' -count=1 -v 2>&1 | tee "$work/$dialect-$scenario-startup.log"
  done
done
unset CONTENT_AUDIT_STARTUP_DIALECT CONTENT_AUDIT_STARTUP_SCENARIO

go test ./service -run '^TestContentAudit(DatabaseMatrix|LogDatabaseMatrix|SingleInstance.*|CrashRecoveryProcesses)$' -count=1 -v 2>&1 | tee "$work/behavior-matrix.log"
printf 'Content-audit matrix passed; artifacts retained at %s\n' "$work"
