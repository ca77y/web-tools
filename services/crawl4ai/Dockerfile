# Custom Crawl4AI image.
#
# The upstream unclecode/crawl4ai image's Playwright headless-shell binary is
# absent from the path Crawl4AI resolves at runtime
# (/home/appuser/.cache/ms-playwright), so the server crashes on boot with:
#   playwright._impl._errors.Error: BrowserType.launch: Executable doesn't
#   exist at .../chromium_headless_shell-<rev>/.../chrome-headless-shell
#
# Reinstall the browsers into that exact path using the SAME Python/Playwright
# the server imports (invoke via `python -m playwright` so the revision matches
# what the runtime expects), as root, then hand the cache back to appuser. The
# final glob `ls` fails the build if the headless-shell binary is not present,
# so a green build guarantees the runtime will find it.
#
# Playwright lays the headless shell down at a different path per architecture:
#   amd64: chromium_headless_shell-<rev>/chrome-headless-shell-linux64/chrome-headless-shell
#   arm64: chromium_headless_shell-<rev>/chrome-linux/headless_shell
# The guard accepts either, so this image builds natively on both. Do not
# narrow it back to one path: `unclecode/crawl4ai:0.9.1` publishes linux/amd64
# and linux/arm64 manifests, and a single-path guard is what previously forced
# arm64 hosts to build the amd64 image under emulation.
FROM unclecode/crawl4ai:0.9.1

ENV PLAYWRIGHT_BROWSERS_PATH=/home/appuser/.cache/ms-playwright
USER root
RUN python -m playwright install chromium chromium-headless-shell \
 && chown -R appuser /home/appuser/.cache \
 && echo "--- installed playwright browsers ---" \
 && ls -la /home/appuser/.cache/ms-playwright \
 && { ls /home/appuser/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell \
   || ls /home/appuser/.cache/ms-playwright/chromium_headless_shell-*/chrome-linux/headless_shell; }
USER appuser
