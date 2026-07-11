# Custom Crawl4AI image.
#
# The upstream `unclecode/crawl4ai:latest` tag drifted to a build whose
# Playwright browser binaries are absent from the path Crawl4AI looks in
# (/home/appuser/.cache/ms-playwright/...), so the server crashed on boot with:
#   playwright._impl._errors.Error: BrowserType.launch: Executable doesn't
#   exist at .../chrome-headless-shell-linux64/chrome-headless-shell
#
# Pin a stable release and re-install the browsers (including the headless
# shell that Crawl4AI actually launches) so the binary is guaranteed present.
# The base image's final USER is `appuser`, so `playwright install` here writes
# to /home/appuser/.cache/ms-playwright — exactly where Crawl4AI resolves it.
# Entrypoint, port 11235, auth/Redis env handling are all inherited unchanged.
FROM unclecode/crawl4ai:0.9.1

# Install the browsers into the exact cache dir the runtime resolves. The
# server runs as `appuser` and looks in $HOME/.cache/ms-playwright, so pin
# PLAYWRIGHT_BROWSERS_PATH there (a build-only `playwright install` as the
# default user landed them elsewhere and the launch still failed). Install as
# root, then hand ownership back to appuser so it can read them at runtime.
ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright
USER root
RUN playwright install chromium chromium-headless-shell \
    && chown -R appuser /home/appuser/.cache
USER appuser
