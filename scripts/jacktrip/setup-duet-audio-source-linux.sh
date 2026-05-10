#!/usr/bin/env bash
set -euo pipefail

SINK_NAME="${1:-jacktrip_duet}"
SINK_DESCRIPTION="${2:-JackTrip Duet Sink}"
MONITOR_SOURCE="${SINK_NAME}.monitor"
VIRTUAL_SOURCE_NAME="${SINK_NAME}_input"
VIRTUAL_SOURCE_DESCRIPTION="${3:-JackTrip Duet Mic}"
PIPEWIRE_RUNNING=0
WIREPLUMBER_RUNNING=0

emit() {
  printf '%s=%s\n' "$1" "${2-}"
}

detect_runtime() {
  if command -v pgrep >/dev/null 2>&1; then
    if pgrep -x pipewire >/dev/null 2>&1; then
      PIPEWIRE_RUNNING=1
    fi
    if pgrep -x wireplumber >/dev/null 2>&1; then
      WIREPLUMBER_RUNNING=1
    fi
  fi
}

fail() {
  local code="$1"
  local message="$2"
  emit status error
  emit error_code "$code"
  emit error_message "$message"
  emit sink_name "$SINK_NAME"
  emit source_name "$MONITOR_SOURCE"
  emit pipewire_running "$PIPEWIRE_RUNNING"
  emit wireplumber_running "$WIREPLUMBER_RUNNING"
  exit 1
}

extract_description() {
  local kind="$1"
  local name="$2"
  pactl list "$kind" 2>/dev/null | awk -v target="$name" '
    /^[[:space:]]*Name:/ {
      line=$0
      sub(/^[[:space:]]*Name:[[:space:]]*/, "", line)
      current=line
    }
    /^[[:space:]]*Description:/ {
      line=$0
      sub(/^[[:space:]]*Description:[[:space:]]*/, "", line)
      if (current==target) {
        print line
        exit
      }
    }'
}

source_exists() {
  local source_name="$1"
  pactl list short sources | awk '{print $2}' | grep -Fx "$source_name" >/dev/null 2>&1
}

is_duet_like_source() {
  local source_name="$1"
  case "$source_name" in
    "${SINK_NAME}"|"${MONITOR_SOURCE}"|"${VIRTUAL_SOURCE_NAME}")
      return 0
      ;;
  esac
  case "$source_name" in
    *jacktrip_duet*|*.monitor)
      return 0
      ;;
  esac
  return 1
}

pick_restore_source() {
  pactl list short sources 2>/dev/null | awk '{print $2}' | while read -r src; do
    [ -z "$src" ] && continue
    if is_duet_like_source "$src"; then
      continue
    fi
    printf '%s\n' "$src"
    break
  done
}

jacktrip_sink_input_ids() {
  pactl list sink-inputs 2>/dev/null | awk '
    /^Sink Input #[0-9]+/ {
      id=$3
      sub(/^#/, "", id)
      is_jacktrip=0
    }
    /^[[:space:]]*application.name = / {
      line=tolower($0)
      if (line ~ /jacktrip/) {
        is_jacktrip=1
      }
    }
    /^[[:space:]]*application.process.binary = / {
      line=tolower($0)
      if (line ~ /jacktrip/) {
        is_jacktrip=1
      }
    }
    /^[[:space:]]*media.name = / {
      line=tolower($0)
      if (line ~ /jacktrip/) {
        is_jacktrip=1
      }
    }
    /^[[:space:]]*$/ {
      if (id != "" && is_jacktrip == 1) {
        print id
      }
      id=""
      is_jacktrip=0
    }
    END {
      if (id != "" && is_jacktrip == 1) {
        print id
      }
    }'
}

detect_runtime

if [ "$(uname -s)" != "Linux" ]; then
  fail "unsupported_os" "linux_only"
fi

if ! command -v pactl >/dev/null 2>&1; then
  fail "missing_tool" "missing pactl; install pulseaudio-utils or enable pipewire-pulse"
fi

SET_DEFAULT_SOURCE_REQUESTED=0
DUET_SET_DEFAULT_SOURCE_VALUE="${DUET_SET_DEFAULT_SOURCE:-0}"
case "$(printf '%s' "${DUET_SET_DEFAULT_SOURCE_VALUE}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    SET_DEFAULT_SOURCE_REQUESTED=1
    ;;
esac

DEFAULT_SOURCE_BEFORE="$(pactl get-default-source 2>/dev/null || true)"

SINK_EXISTS=0
if pactl list short sinks | awk '{print $2}' | grep -Fx "$SINK_NAME" >/dev/null 2>&1; then
  SINK_EXISTS=1
fi

CREATED_SINK=0
SINK_MODULE_ID=""
if [ "$SINK_EXISTS" -eq 0 ]; then
  if ! SINK_MODULE_ID="$(pactl load-module module-null-sink "sink_name=${SINK_NAME}")"; then
    fail "create_sink_failed" "unable to create virtual sink '${SINK_NAME}'"
  fi
  pactl update-sink-proplist "$SINK_NAME" "device.description=${SINK_DESCRIPTION}" >/dev/null 2>&1 || true
  pactl update-source-proplist "$MONITOR_SOURCE" "device.description=Monitor of ${SINK_DESCRIPTION}" >/dev/null 2>&1 || true
  CREATED_SINK=1
fi

if ! source_exists "$MONITOR_SOURCE"; then
  fail "monitor_missing" "monitor source '${MONITOR_SOURCE}' not found"
fi

VIRTUAL_SOURCE_EXISTS=0
CREATED_VIRTUAL_SOURCE=0
VIRTUAL_SOURCE_MODULE_ID=""
if source_exists "$VIRTUAL_SOURCE_NAME"; then
  VIRTUAL_SOURCE_EXISTS=1
else
  if VIRTUAL_SOURCE_MODULE_ID="$(pactl load-module module-remap-source "master=${MONITOR_SOURCE}" "source_name=${VIRTUAL_SOURCE_NAME}")"; then
    pactl update-source-proplist "$VIRTUAL_SOURCE_NAME" "device.description=${VIRTUAL_SOURCE_DESCRIPTION}" >/dev/null 2>&1 || true
    VIRTUAL_SOURCE_EXISTS=1
    CREATED_VIRTUAL_SOURCE=1
  fi
fi

PICK_SOURCE_NAME="$MONITOR_SOURCE"
if [ "$VIRTUAL_SOURCE_EXISTS" -eq 1 ]; then
  PICK_SOURCE_NAME="$VIRTUAL_SOURCE_NAME"
fi

SET_DEFAULT_SOURCE=0
if [ "$SET_DEFAULT_SOURCE_REQUESTED" -eq 1 ]; then
  if pactl set-default-source "$PICK_SOURCE_NAME" >/dev/null 2>&1; then
    SET_DEFAULT_SOURCE=1
  fi
fi
DEFAULT_SOURCE_AFTER="$(pactl get-default-source 2>/dev/null || true)"
if [ -z "$DEFAULT_SOURCE_AFTER" ] && [ -n "$DEFAULT_SOURCE_BEFORE" ]; then
  DEFAULT_SOURCE_AFTER="$DEFAULT_SOURCE_BEFORE"
fi
DEFAULT_SOURCE_CHANGED=0
if [ "$DEFAULT_SOURCE_BEFORE" != "$DEFAULT_SOURCE_AFTER" ]; then
  DEFAULT_SOURCE_CHANGED=1
fi

DEFAULT_SOURCE_IS_DUET=0
if [ -n "$DEFAULT_SOURCE_AFTER" ] && is_duet_like_source "$DEFAULT_SOURCE_AFTER"; then
  DEFAULT_SOURCE_IS_DUET=1
fi

RECOMMENDED_RESTORE_SOURCE=""
RECOMMENDED_RESTORE_LABEL=""
if [ "$DEFAULT_SOURCE_IS_DUET" -eq 1 ]; then
  RECOMMENDED_RESTORE_SOURCE="$(pick_restore_source || true)"
  if [ -n "$RECOMMENDED_RESTORE_SOURCE" ]; then
    RECOMMENDED_RESTORE_LABEL="$(extract_description sources "$RECOMMENDED_RESTORE_SOURCE" || true)"
  fi
fi

MOVED_INPUTS=0
MOVED_INPUT_IDS=""
while read -r input_id; do
  [ -z "$input_id" ] && continue
  if pactl move-sink-input "$input_id" "$SINK_NAME" >/dev/null 2>&1; then
    MOVED_INPUTS=$((MOVED_INPUTS + 1))
    if [ -z "$MOVED_INPUT_IDS" ]; then
      MOVED_INPUT_IDS="$input_id"
    else
      MOVED_INPUT_IDS="${MOVED_INPUT_IDS},${input_id}"
    fi
  fi
done < <(jacktrip_sink_input_ids || true)

SINK_LABEL="$(extract_description sinks "$SINK_NAME" || true)"
SOURCE_LABEL="$(extract_description sources "$PICK_SOURCE_NAME" || true)"

if [ -z "$SINK_LABEL" ]; then
  SINK_LABEL="$SINK_DESCRIPTION"
fi
if [ -z "$SOURCE_LABEL" ]; then
  if [ "$PICK_SOURCE_NAME" = "$VIRTUAL_SOURCE_NAME" ]; then
    SOURCE_LABEL="$VIRTUAL_SOURCE_DESCRIPTION"
  else
    SOURCE_LABEL="Monitor of ${SINK_LABEL}"
  fi
fi

emit status ok
emit backend pactl
emit sink_name "$SINK_NAME"
emit sink_description "$SINK_LABEL"
emit source_name "$PICK_SOURCE_NAME"
emit source_description "$SOURCE_LABEL"
emit browser_pick_label "$SOURCE_LABEL"
emit sink_exists "$SINK_EXISTS"
emit created_sink "$CREATED_SINK"
emit virtual_source_name "$VIRTUAL_SOURCE_NAME"
emit virtual_source_exists "$VIRTUAL_SOURCE_EXISTS"
emit created_virtual_source "$CREATED_VIRTUAL_SOURCE"
emit moved_inputs_count "$MOVED_INPUTS"
emit moved_input_ids "$MOVED_INPUT_IDS"
emit sink_module_id "$SINK_MODULE_ID"
emit virtual_source_module_id "$VIRTUAL_SOURCE_MODULE_ID"
emit default_source_before "$DEFAULT_SOURCE_BEFORE"
emit default_source_after "$DEFAULT_SOURCE_AFTER"
emit set_default_source_requested "$SET_DEFAULT_SOURCE_REQUESTED"
emit set_default_source "$SET_DEFAULT_SOURCE"
emit default_source_changed "$DEFAULT_SOURCE_CHANGED"
emit default_source_is_duet "$DEFAULT_SOURCE_IS_DUET"
emit recommended_restore_source "$RECOMMENDED_RESTORE_SOURCE"
emit recommended_restore_label "$RECOMMENDED_RESTORE_LABEL"
emit pipewire_running "$PIPEWIRE_RUNNING"
emit wireplumber_running "$WIREPLUMBER_RUNNING"
