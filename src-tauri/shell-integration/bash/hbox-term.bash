# hbox-term shell integration for bash 3.2 or later. Add to ~/.bashrc:
#
#   [[ -n $HBOX_TERM_SHELL_INTEGRATION ]] && source "$HBOX_TERM_SHELL_INTEGRATION/bash/hbox-term.bash"

[[ $- == *i* ]] || return 0
[[ -n $_hbox_loaded ]] && return 0
_hbox_loaded=1

# Marks prompts and commands with OSC 133 and reports the directory with OSC 7.
# A command-end mark without a preceding command-start (an empty line) is ignored by hbox-term.
_hbox_prompt() {
  local exit_status=$?
  _hbox_in_prompt=1
  [[ -n $_hbox_prompted ]] && printf '\e]133;D;%s\a' "$exit_status"
  _hbox_prompted=1
  local path=${PWD//%/%25}
  path=${path// /%20}
  path=${path//#/%23}
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "${path//\?/%3F}"
  printf '\e]133;A\a'
  return "$exit_status"
}

_hbox_prompt_end() {
  local exit_status=$?
  _hbox_in_prompt=
  _hbox_command_running=
  return "$exit_status"
}

if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  # PS0 is printed after a command line is read, right before it runs.
  PS0='\e]133;C\a'"${PS0}"
elif [[ -z $(trap -p DEBUG) ]]; then
  # macOS ships Bash 3.2, which does not expand PS0. Emit one start per
  # interactive command line, outside prompt hooks. Preserve existing DEBUG
  # traps rather than replacing another tool's pre-execution integration.
  _hbox_in_prompt=1
  _hbox_preexec() {
    [[ -n $_hbox_in_prompt || -n $_hbox_command_running ]] && return 0
    case $BASH_COMMAND in _hbox_prompt*) return 0 ;; esac
    _hbox_command_running=1
    printf '\e]133;C\a'
  }
  trap '_hbox_preexec' DEBUG
fi
PROMPT_COMMAND="_hbox_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; _hbox_prompt_end"
