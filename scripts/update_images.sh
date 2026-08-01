#!/usr/bin/env bash
# ==============================================================================
# CloudAtlas Docker Image Update Script
# Usage: ./scripts/update_images.sh [OPTIONS] [SERVICE...]
#
# SERVICE: api | frontend | migrate | all (default: all)
#
# Options:
#   -t, --tag TAG          Image tag (default: git short SHA or "latest")
#   -r, --registry URL     Registry prefix, e.g. ghcr.io/myorg/cloudatlas
#   -p, --push             Push images to registry after build
#   -n, --no-cache         Build without Docker layer cache
#   -e, --env ENV          Compose env: prod (default) | dev
#   --restart              Restart running containers after build
#   --dry-run              Print commands without executing
#   -h, --help             Show this help
#
# Examples:
#   ./scripts/update_images.sh                       # rebuild all images
#   ./scripts/update_images.sh api                   # rebuild api only
#   ./scripts/update_images.sh -t v1.2.0 --push all  # tag + push to registry
#   ./scripts/update_images.sh --no-cache --restart  # force full rebuild + restart
# ==============================================================================
set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERR]${NC}   $*" >&2; }
step()    { echo -e "\n${BOLD}──── $* ────${NC}"; }

# ── Defaults ──────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TAG=""
REGISTRY=""
PUSH=false
NO_CACHE=false
COMPOSE_ENV="prod"
DO_RESTART=false
DRY_RUN=false
SERVICES=()

# ── Argument parsing ──────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--tag)       TAG="$2";      shift 2 ;;
    -r|--registry)  REGISTRY="$2"; shift 2 ;;
    -p|--push)      PUSH=true;     shift   ;;
    -n|--no-cache)  NO_CACHE=true; shift   ;;
    -e|--env)       COMPOSE_ENV="$2"; shift 2 ;;
    --restart)      DO_RESTART=true; shift  ;;
    --dry-run)      DRY_RUN=true;  shift   ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# //;s/^#//'
      exit 0 ;;
    all|api|frontend|migrate)
      SERVICES+=("$1"); shift ;;
    *)
      error "Unknown argument: $1"
      exit 1 ;;
  esac
done

# Default to all services if none specified
if [[ ${#SERVICES[@]} -eq 0 ]] || [[ "${SERVICES[*]}" == *"all"* ]]; then
  SERVICES=(api frontend migrate)
fi

# Resolve image tag (prefer explicit flag → git SHA → "latest")
if [[ -z "$TAG" ]]; then
  if git -C "$PROJECT_DIR" rev-parse --short HEAD &>/dev/null; then
    TAG="$(git -C "$PROJECT_DIR" rev-parse --short HEAD)"
  else
    TAG="latest"
  fi
fi

# Compose file selection
if [[ "$COMPOSE_ENV" == "dev" ]]; then
  COMPOSE_FILE="docker-compose.dev.yml"
else
  COMPOSE_FILE="docker-compose.yml"
fi

# ── Dry-run wrapper ───────────────────────────────────────────────────────────
run() {
  if $DRY_RUN; then
    echo -e "${YELLOW}[DRY-RUN]${NC} $*"
  else
    "$@"
  fi
}

# ── Preflight checks ──────────────────────────────────────────────────────────
step "Preflight"

if ! command -v docker &>/dev/null; then
  error "docker not found. Install Docker and retry."
  exit 1
fi

if ! docker info &>/dev/null; then
  error "Docker daemon is not running."
  exit 1
fi

cd "$PROJECT_DIR"

if [[ ! -f "$COMPOSE_FILE" ]]; then
  error "Compose file not found: $PROJECT_DIR/$COMPOSE_FILE"
  exit 1
fi

info "Project dir : $PROJECT_DIR"
info "Compose file: $COMPOSE_FILE"
info "Services    : ${SERVICES[*]}"
info "Image tag   : $TAG"
[[ -n "$REGISTRY" ]] && info "Registry    : $REGISTRY"
$NO_CACHE  && info "No-cache    : enabled"
$PUSH      && info "Push        : enabled"
$DO_RESTART && info "Restart     : enabled"
$DRY_RUN   && warn "DRY-RUN mode — no changes will be made"

# ── Build ─────────────────────────────────────────────────────────────────────
step "Building images"

BUILD_ARGS=(docker compose -f "$COMPOSE_FILE" build)
$NO_CACHE && BUILD_ARGS+=(--no-cache)
BUILD_ARGS+=(--pull)                   # always pull fresher base images

for svc in "${SERVICES[@]}"; do
  BUILD_ARGS+=("$svc")
done

info "Running: ${BUILD_ARGS[*]}"
run "${BUILD_ARGS[@]}"
success "Build complete"

# Map service name → compose image name (bash 3 compatible)
service_image() {
  case "$1" in
    api)      echo "cloudatlas-api"      ;;
    frontend) echo "cloudatlas-frontend" ;;
    migrate)  echo "cloudatlas-migrate"  ;;
    *)        echo "cloudatlas-$1"       ;;
  esac
}

# ── Tag ───────────────────────────────────────────────────────────────────────
if [[ "$TAG" != "latest" ]] || [[ -n "$REGISTRY" ]]; then
  step "Tagging images"

  for svc in "${SERVICES[@]}"; do
    local_image="$(service_image "$svc")"

    # Determine full target name
    if [[ -n "$REGISTRY" ]]; then
      target_base="${REGISTRY}/${svc}"
    else
      target_base="$local_image"
    fi

    # Tag with the resolved tag; also :latest when an explicit tag is given
    run docker tag "$local_image" "${target_base}:${TAG}"
    success "Tagged  $local_image  →  ${target_base}:${TAG}"

    if [[ "$TAG" != "latest" ]]; then
      run docker tag "$local_image" "${target_base}:latest"
      success "Tagged  $local_image  →  ${target_base}:latest"
    fi
  done
fi

# ── Push ──────────────────────────────────────────────────────────────────────
if $PUSH; then
  step "Pushing images to registry"

  if [[ -z "$REGISTRY" ]]; then
    warn "No --registry set. Pushing images with their local names."
  fi

  for svc in "${SERVICES[@]}"; do
    local_image="$(service_image "$svc")"
    push_target="${REGISTRY:+${REGISTRY}/${svc}}"
    push_target="${push_target:-$local_image}"

    run docker push "${push_target}:${TAG}"
    success "Pushed ${push_target}:${TAG}"

    if [[ "$TAG" != "latest" ]]; then
      run docker push "${push_target}:latest"
      success "Pushed ${push_target}:latest"
    fi
  done
fi

# ── Restart ───────────────────────────────────────────────────────────────────
if $DO_RESTART; then
  step "Restarting containers"

  for svc in "${SERVICES[@]}"; do
    # Skip migrate — it's a one-shot job, not a long-running service
    if [[ "$svc" == "migrate" ]]; then
      info "Skipping restart for 'migrate' (one-shot service)"
      continue
    fi

    info "Restarting $svc …"
    run docker compose -f "$COMPOSE_FILE" up -d --no-deps --force-recreate "$svc"
    success "Restarted $svc"
  done

  # Brief health-check wait
  if ! $DRY_RUN; then
    step "Waiting for health checks"
    sleep 5

    for svc in api frontend; do
      if [[ " ${SERVICES[*]} " =~ " ${svc} " ]]; then
        container="cloudatlas-${svc}"
        health="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "no-healthcheck")"
        if [[ "$health" == "healthy" ]] || [[ "$health" == "no-healthcheck" ]]; then
          success "$container → $health"
        else
          warn "$container → $health (may still be starting)"
        fi
      fi
    done
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────
step "Done"
success "Services updated: ${SERVICES[*]}"
success "Tag             : $TAG"
$PUSH    && success "Images pushed to registry"
$DO_RESTART && success "Containers restarted"

if ! $DO_RESTART; then
  info "Tip: add --restart to automatically recreate running containers."
fi
