# hbox-term shell integration for fish, loaded through XDG_DATA_DIRS.

# Drop our directory again so programs started from this shell do not see it.
if set -q HBOX_TERM_FISH_DATA_DIR
    set -l dirs (string split : -- "$XDG_DATA_DIRS")
    set -gx XDG_DATA_DIRS (string join : -- (string match -v -- "$HBOX_TERM_FISH_DATA_DIR" $dirs))
    test -z "$XDG_DATA_DIRS"; and set -e XDG_DATA_DIRS
    set -e HBOX_TERM_FISH_DATA_DIR
end

status is-interactive; or exit 0

# Marks prompts and commands with OSC 133 and reports the directory with OSC 7.
function __hbox_prompt --on-event fish_prompt
    printf '\e]7;file://%s%s\a' (hostname) (string escape --style=url -- $PWD | string replace -a '%2F' '/')
    printf '\e]133;A\a'
end

function __hbox_preexec --on-event fish_preexec
    printf '\e]133;C\a'
end

function __hbox_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end
