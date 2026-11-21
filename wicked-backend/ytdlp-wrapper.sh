#!/bin/bash
exec /usr/bin/setpriv --reuid=ytdlp --regid=ytdlp --init-groups \
  env HOME=/var/lib/ytdlp \
  /opt/wicked/backend/node_modules/youtube-dl-exec/bin/yt-dlp.real --force-ipv4 --js-runtimes node --remote-components ejs:github "$@"
