# hbox-term starts bash as `bash --rcfile <this file> -i`, which reads only this file. Do what a
# login shell does (as a terminal would start it), then load the integration.
[ -r /etc/profile ] && . /etc/profile
if [ -r ~/.bash_profile ]; then
  . ~/.bash_profile
elif [ -r ~/.bash_login ]; then
  . ~/.bash_login
elif [ -r ~/.profile ]; then
  . ~/.profile
fi
. "$(dirname "${BASH_SOURCE[0]}")/hbox-term.bash"
