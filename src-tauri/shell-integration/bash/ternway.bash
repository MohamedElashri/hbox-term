# ternway shell integration for bash 3.2 or later. Add to ~/.bashrc:
#
#   [[ -n $TERNWAY_SHELL_INTEGRATION ]] && source "$TERNWAY_SHELL_INTEGRATION/bash/ternway.bash"

[[ $- == *i* ]] || return 0
[[ -n $_ternway_loaded ]] && return 0
_ternway_loaded=1

# Marks prompts and commands with OSC 133 and reports the directory with OSC 7.
# A command-end mark without a preceding command-start (an empty line) is ignored by ternway.
_ternway_prompt() {
  local exit_status=$?
  _ternway_in_prompt=1
  [[ -n $_ternway_prompted ]] && printf '\e]133;D;%s\a' "$exit_status"
  _ternway_prompted=1
  local path=${PWD//%/%25}
  path=${path// /%20}
  path=${path//#/%23}
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "${path//\?/%3F}"
  printf '\e]133;A\a'
  return "$exit_status"
}

_ternway_prompt_end() {
  local exit_status=$?
  _ternway_in_prompt=
  _ternway_command_running=
  return "$exit_status"
}

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  # PS0 is printed after a command line is read, right before it runs.
  PS0='\e]133;C\a'"${PS0}"
elif [[ -z $(trap -p DEBUG) ]]; then
  # macOS ships Bash 3.2, which does not expand PS0. Emit one start per
  # interactive command line, outside prompt hooks. Preserve existing DEBUG
  # traps rather than replacing another tool's pre-execution integration.
  _ternway_in_prompt=1
  _ternway_preexec() {
    [[ -n $_ternway_in_prompt || -n $_ternway_command_running ]] && return 0
    case $BASH_COMMAND in _ternway_prompt*) return 0 ;; esac
    _ternway_command_running=1
    printf '\e]133;C\a'
  }
  trap '_ternway_preexec' DEBUG
fi
PROMPT_COMMAND="_ternway_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; _ternway_prompt_end"
