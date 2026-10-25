# hbox-term shell integration for bash 4.4 or later. Add to ~/.bashrc:
#
#   [[ -n $HBOX_TERM_SHELL_INTEGRATION ]] && source "$HBOX_TERM_SHELL_INTEGRATION/bash/hbox-term.bash"

[[ $- == *i* ]] || return 0
[[ -n $_hbox_loaded ]] && return 0
_hbox_loaded=1

# Marks prompts and commands with OSC 133 and reports the directory with OSC 7.
# A command-end mark without a preceding command-start (an empty line) is ignored by hbox-term.
_hbox_prompt() {
  local exit_status=$?
  [[ -n $_hbox_prompted ]] && printf '\e]133;D;%s\a' "$exit_status"
  _hbox_prompted=1
  local path=${PWD//%/%25}
  path=${path// /%20}
  path=${path//#/%23}
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "${path//\?/%3F}"
  printf '\e]133;A\a'
  return "$exit_status"
}

# PS0 is printed after a command line is read, right before it runs.
PS0='\e]133;C\a'"${PS0}"
PROMPT_COMMAND="_hbox_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
