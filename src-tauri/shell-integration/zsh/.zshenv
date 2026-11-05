# ternway shell integration for zsh.
#
# ternway starts zsh with ZDOTDIR pointing here. Restore the user's ZDOTDIR first, so zsh reads
# their .zprofile, .zshrc and .zlogin as usual, then run their .zshenv.
if [[ -n "${TERNWAY_ZDOTDIR+x}" ]]; then
  ZDOTDIR="$TERNWAY_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset TERNWAY_ZDOTDIR
if [[ -r "${ZDOTDIR:-$HOME}/.zshenv" ]]; then
  builtin source "${ZDOTDIR:-$HOME}/.zshenv"
fi

[[ -o interactive ]] || return 0

# Marks prompts and commands with OSC 133 and reports the directory with OSC 7.
typeset -g _ternway_command_running=0

_ternway_url_path() {
  local path="${PWD//\%/%25}"
  path="${path// /%20}"
  path="${path//\#/%23}"
  builtin print -rn -- "${path//\?/%3F}"
}

_ternway_precmd() {
  local exit_status=$?
  if (( _ternway_command_running )); then
    builtin printf '\e]133;D;%s\a' "$exit_status"
    _ternway_command_running=0
  fi
  builtin printf '\e]7;file://%s%s\a' "${HOST}" "$(_ternway_url_path)"
  builtin printf '\e]2;%s\a' "${${PWD/#$HOME/~}//[[:cntrl:]]/}"
  builtin printf '\e]133;A\a'
}

_ternway_preexec() {
  builtin printf '\e]2;%s\a' "${${1[1,120]}//[[:cntrl:]]/}"
  builtin printf '\e]133;C\a'
  _ternway_command_running=1
}

autoload -Uz add-zsh-hook
# First in line, so the exit status is the command's and not another hook's.
precmd_functions=(_ternway_precmd ${precmd_functions[@]})
add-zsh-hook preexec _ternway_preexec
