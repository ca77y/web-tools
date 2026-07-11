FROM searxng/searxng:latest

COPY settings.yml /etc/searxng/settings.yml.tpl

ADD google_sorry_fix.py /tmp/google_sorry_fix.py
RUN GOOGLE_PY=/usr/local/searxng/searx/engines/google.py && \
    python3 /tmp/google_sorry_fix.py "$GOOGLE_PY" && \
    rm /tmp/google_sorry_fix.py && \
    find /usr/local/searxng/searx -name "__pycache__" -type d -exec rm -rf {} + && \
    python3 -m compileall -q -f -j 0 --invalidation-mode=unchecked-hash /usr/local/searxng/searx/

ENTRYPOINT ["sh", "-c", "\
if [ -n \"$PROXY_URL\" ]; then \
  sed \"s|\\${PROXY_URL}|$PROXY_URL|g\" /etc/searxng/settings.yml.tpl > /etc/searxng/settings.yml; \
  echo Proxy: enabled; \
else \
  sed '/proxies:/,/PROXY_URL}/d' /etc/searxng/settings.yml.tpl > /etc/searxng/settings.yml; \
  echo Proxy: disabled; \
fi && \
exec /usr/local/searxng/.venv/bin/granian --interface wsgi --host 0.0.0.0 --port 8080 --workers 4 --blocking-threads 8 searx.webapp:app"]
