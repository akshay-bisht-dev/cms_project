#!/usr/bin/env bash
# Runs MySQL 8.4 from the official tarball without Docker or admin rights (macOS/Linux dev only).
# Data, logs and the socket live in .local/mysql (gitignored). Listens on 127.0.0.1:3306 only.
#
#   infrastructure/scripts/local-mysql.sh start   # first run initializes and creates dev users/databases
#   infrastructure/scripts/local-mysql.sh stop
#   infrastructure/scripts/local-mysql.sh status
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LOCAL="$ROOT/.local"
VERSION="${MYSQL_VERSION:-8.4.10}"
case "$(uname -s)-$(uname -m)" in
  Darwin-x86_64) PKG="mysql-$VERSION-macos15-x86_64" ;;
  Darwin-arm64)  PKG="mysql-$VERSION-macos15-arm64" ;;
  *) echo "Unsupported platform for this helper; use docker compose instead." >&2; exit 1 ;;
esac
TARBALL="$LOCAL/downloads/$PKG.tar.gz"
BASEDIR="$LOCAL/$PKG"
DATADIR="$LOCAL/mysql/data"
RUNDIR="$LOCAL/mysql/run"
CNF="$LOCAL/mysql/my.cnf"
MYSQL="$BASEDIR/bin/mysql"

write_cnf() {
  mkdir -p "$RUNDIR" "$DATADIR"
  {
    echo "[mysqld]"
    echo "basedir = $BASEDIR"
    echo "datadir = $DATADIR"
    echo "socket = $RUNDIR/mysql.sock"
    echo "pid-file = $RUNDIR/mysqld.pid"
    echo "log-error = $RUNDIR/mysqld.err"
    echo "bind-address = 127.0.0.1"
    echo "port = 3306"
    echo "mysqlx = OFF"
    # Same server settings as the docker-compose MySQL.
    grep -v '^\[mysqld\]' "$ROOT/infrastructure/mysql/my.cnf"
  } > "$CNF"
}

start() {
  if [[ ! -x "$BASEDIR/bin/mysqld" ]]; then
    if [[ ! -f "$TARBALL" ]]; then
      mkdir -p "$LOCAL/downloads"
      curl -fSL -o "$TARBALL" "https://cdn.mysql.com/Downloads/MySQL-8.4/$PKG.tar.gz"
    fi
    tar -xzf "$TARBALL" -C "$LOCAL"
  fi
  write_cnf
  local fresh=0
  if [[ ! -d "$DATADIR/mysql" ]]; then
    "$BASEDIR/bin/mysqld" --defaults-file="$CNF" --initialize-insecure
    fresh=1
  fi
  if status >/dev/null 2>&1; then echo "MySQL already running"; return; fi
  "$BASEDIR/bin/mysqld" --defaults-file="$CNF" --daemonize >/dev/null
  for _ in $(seq 1 60); do
    "$BASEDIR/bin/mysqladmin" --no-defaults --socket="$RUNDIR/mysql.sock" -uroot ping >/dev/null 2>&1 && break
    sleep 1
  done
  if [[ $fresh -eq 1 ]]; then
    "$MYSQL" --no-defaults --socket="$RUNDIR/mysql.sock" -uroot <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED BY 'orbit_root_dev';
CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY 'orbit_root_dev';
GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
SQL
    "$MYSQL" --no-defaults --socket="$RUNDIR/mysql.sock" -uroot -porbit_root_dev < "$ROOT/infrastructure/mysql/init/01-databases.sql"
  fi
  echo "MySQL $VERSION running on 127.0.0.1:3306 (logs: $RUNDIR/mysqld.err)"
}

stop() {
  "$BASEDIR/bin/mysqladmin" --no-defaults --socket="$RUNDIR/mysql.sock" -uroot -porbit_root_dev shutdown 2>/dev/null && echo "MySQL stopped" || echo "MySQL not running"
}

status() {
  "$BASEDIR/bin/mysqladmin" --no-defaults --socket="$RUNDIR/mysql.sock" -uroot -porbit_root_dev ping
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  *) echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
