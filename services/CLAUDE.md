# Services

Runtime service images and configuration supporting the Web Tools application.

## Rules

- Preserve the four-service topology: Web Tools, Crawl4AI, SearXNG, and Redis.
- Keep SearXNG-specific settings and image changes under `searxng/`.
- Keep Crawl4AI image customizations under `crawl4ai/`; toolkit clients own its application protocol.
- Keep credentials and environment-specific values out of version control.
- Maintain compatibility with both Docker Compose and the deployment model in `docs/ARCHITECTURE.md`.
- Document changes that alter service ownership, dependencies, ports, or operator recovery steps.
