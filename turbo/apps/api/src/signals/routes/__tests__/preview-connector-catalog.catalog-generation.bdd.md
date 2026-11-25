# preview-connector-catalog.catalog-generation

## preview-connector-catalog.catalog-generation-001

- Vitest: "serves the existing catalog through discovery, detail and authenticated Runner firewall lookup"
- Mode: run
- Given: An authenticated workspace caller and an official Runner are using a deployment that already has an active connector catalog including GitHub and GitLab.
- When: The caller lists GET /api/connector-catalog, reads /api/connector-catalog/gitlab and searches /api/connector-catalog/discovery for gitlab. The Runner posts github and gitlab to /api/runners/builtin-firewalls/resolve using official Runner authentication.
- Then: All four requests return HTTP 200. The list contains both slugs. The detail returns the gitlab slug and GitLab label, discovery includes gitlab and the firewall response has exactly the two requested keys.
