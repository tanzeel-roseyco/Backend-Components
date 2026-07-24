# Sitemap generator

This component builds sitemap XML from caller-supplied static routes and dynamic entries. It can return the XML as a string or write it to disk for a build step.

Callers provide an origin, route metadata, dynamic-entry mapping options, and an optional output path. If no origin is passed, `SITE_ORIGIN` is read and then a neutral example origin is used as the final fallback. URL values are XML-escaped, invalid dynamic dates are omitted, and missing route dates fall back to the current day.

Writing a sitemap creates the parent directory and overwrites the target file. The module warns when more than 50,000 URLs are generated, but it does not split them into a sitemap index or enforce the 50 MB sitemap size limit. Dynamic content must already be available when it runs.

It uses only Node's `fs` and `path` modules. There is no dedicated test file in this repository.
