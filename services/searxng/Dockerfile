FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml.tpl

# No source patching. `google_sorry_fix.py` used to be applied here, monkey-
# patching searx/engines/google.py at build time; it was removed on 2026-07-23
# along with the `google` engine it existed to prop up. Google's HTML endpoint
# is now JS-gated (every response is the "enablejs" interstitial), so no
# amount of /sorry/ detection or fallback parsing recovers a result — see the
# `google cse` comment in settings.yml. The patch also carried LinkedIn
# profile-location enrichment belonging to an unrelated problem domain, and
# injected itself by string-replacing the file's last `return results`.
#
# Keeping the base image unpatched is what lets this Dockerfile stay a plain
# COPY: nothing under /usr/local/searxng is modified, so the bytecode-recompile
# step that used to follow the patch is unnecessary.

ENTRYPOINT ["sh", "-c", "\
if [ -n \"$PROXY_URL\" ]; then \
  sed \"s|\\${PROXY_URL}|$PROXY_URL|g\" /etc/searxng/settings.yml.tpl > /etc/searxng/settings.yml; \
  echo Proxy: enabled; \
else \
  sed '/proxies:/,/PROXY_URL}/d' /etc/searxng/settings.yml.tpl > /etc/searxng/settings.yml; \
  echo Proxy: disabled; \
fi && \
exec /usr/local/searxng/.venv/bin/granian --interface wsgi --host 0.0.0.0 --port 8080 --workers 4 --blocking-threads 8 searx.webapp:app"]
