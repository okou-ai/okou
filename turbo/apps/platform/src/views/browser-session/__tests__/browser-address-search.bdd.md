# Browser address search

Baseline [b0a10287edf4](https://github.com/okou-ai/okou/tree/b0a10287edf4242383c28e39c6f7675053febb32).
Source [browser-address-search.test.tsx](browser-address-search.test.tsx).

## browser-address-search-001

Original test `Plain text opens Google search on the selected page (blank=false)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L97).

- **Given** A remote browser is open with a selected page at https://sales.example/report.
- **When** The user enters “quarterly sales” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=quarterly+sales.

## browser-address-search-002

Original test `Plain text opens Google search on the selected page (blank=true)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L97).

- **Given** A remote browser is open with its selected page blank at about:blank.
- **When** The user enters “quarterly sales” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=quarterly+sales.

## browser-address-search-003

Original test `The pointer submit action distinguishes search from direct URL navigation`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L116).

- **Given** A remote browser is open.
- **When** The user enters “annual report” and clicks Search Google, then enters “sales.example/new” and clicks Open address.
- **Then** The first submission resolves to https://www.google.com/search?q=annual+report. The second resolves to http://sales.example/new.

## browser-address-search-004

Original test `Invalid explicit input does not become a search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L136).

- **Given** A remote browser is open.
- **When** The user enters “///invalid” and submits the address.
- **Then** Open address is disabled, an alert appears, and the input remains “///invalid”; it is not turned into a search.

## browser-address-search-005

Original test `Composition confirmation does not submit a search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L147).

- **Given** A remote browser is open and the address contains “季度报告” during text composition.
- **When** The user confirms composition with Enter and submits before composition ends, then presses Enter after composition ends.
- **Then** The composition confirmations do not submit a search. After composition ends, Enter resolves to a Google search whose query is the encoded “季度报告”.

## browser-address-search-006

Original test `Submission retains the original quarterly sales and receipt across document replacement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L184).

- **Given** A remote browser is open and the user has entered “quarterly sales”.
- **When** The user presses Enter while navigation is in progress, then the document is replaced and navigation completes.
- **Then** During navigation the address retains “quarterly sales” and is marked busy; the selected tab identifies www.google.com. After completion, the address is https://www.google.com/search?q=quarterly+sales, it is no longer busy, and remote browser input is enabled.

## browser-address-search-007

Original test `Submission retains the original acmeportal and receipt across document replacement`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L184).

- **Given** A remote browser is open and the user has entered “acmeportal”.
- **When** The user presses Ctrl+Enter while navigation is in progress, then the document is replaced and navigation completes.
- **Then** During navigation the address retains “acmeportal” and is marked busy; the selected tab identifies www.acmeportal.com. After completion, the address is http://www.acmeportal.com/, it is no longer busy, and remote browser input is enabled.

## browser-address-search-008

Original test `A failed domain completion retains the original text for an ordinary search`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L212).

- **Given** A remote browser is open and navigation for the host completion of “acmeportal” fails with a name-resolution error.
- **When** The user presses Ctrl+Enter, then presses Enter after the alert appears.
- **Then** The failed completion leaves “acmeportal” in the address. Enter then resolves it to https://www.google.com/search?q=acmeportal.

## browser-address-search-009

Original test `Google search keeps Unicode and reserved characters in a single query parameter`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L225).

- **Given** A remote browser is open.
- **When** The user enters “季度报告 & revenue + 20% #2026” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A+%26+revenue+%2B+20%25+%232026, keeping the text in one query parameter.

## browser-address-search-010

Original test `The address bar resolves input site:example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “site:example.com” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=site%3Aexample.com.

## browser-address-search-011

Original test `The address bar resolves input filetype:pdf annual report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “filetype:pdf annual report” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=filetype%3Apdf+annual+report.

## browser-address-search-012

Original test `The address bar resolves input custom:report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “custom:report” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=custom%3Areport.

## browser-address-search-013

Original test `The address bar resolves input custom://reports/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “custom://reports/” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=custom%3A%2F%2Freports%2F.

## browser-address-search-014

Original test `The address bar resolves input report.pdf`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “report.pdf” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=report.pdf.

## browser-address-search-015

Original test `The address bar resolves input co.uk`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “co.uk” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=co.uk.

## browser-address-search-016

Original test `The address bar resolves input example..com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “example..com” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=example..com.

## browser-address-search-017

Original test `The address bar resolves input java.awt.event`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “java.awt.event” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=java.awt.event.

## browser-address-search-018

Original test `The address bar resolves input ?example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “?example.com” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=example.com.

## browser-address-search-019

Original test `The address bar resolves input user@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “user@example.com” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=user%40example.com.

## browser-address-search-020

Original test `The address bar resolves input user@example.com/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “user@example.com/path” and presses Enter.
- **Then** The address becomes http://user@example.com/path.

## browser-address-search-021

Original test `The address bar resolves input user:pass@1.2:45`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “user:pass@1.2:45” and presses Enter.
- **Then** The address becomes http://user:pass@1.0.0.2:45/.

## browser-address-search-022

Original test `The address bar resolves input user:@example.com/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “user:@example.com/path” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=user%3A%40example.com%2Fpath.

## browser-address-search-023

Original test `The address bar resolves input :pass@example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “:pass@example.com” and presses Enter.
- **Then** The address becomes http://:pass@example.com/.

## browser-address-search-024

Original test `The address bar resolves input intranet/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “intranet/” and presses Enter.
- **Then** The address becomes http://intranet/.

## browser-address-search-025

Original test `The address bar resolves input //intranet/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “//intranet/path” and presses Enter.
- **Then** The address becomes http://intranet/path.

## browser-address-search-026

Original test `The address bar resolves input example.invalid/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “example.invalid/” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=example.invalid%2F.

## browser-address-search-027

Original test `The address bar resolves input http://invalid/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “http://invalid/” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=http%3A%2F%2Finvalid%2F.

## browser-address-search-028

Original test `The address bar resolves input intranet/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “intranet/path” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=intranet%2Fpath.

## browser-address-search-029

Original test `The address bar resolves input intranet/path?q=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “intranet/path?q=1” and presses Enter.
- **Then** The address becomes http://intranet/path?q=1.

## browser-address-search-030

Original test `The address bar resolves input intranet/report part?q=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “intranet/report part?q=1” and presses Enter.
- **Then** The address becomes http://intranet/report%E2%80%A8part?q=1.

## browser-address-search-031

Original test `The address bar resolves input foo:80`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “foo:80” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=foo%3A80.

## browser-address-search-032

Original test `The address bar resolves input foo:81`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “foo:81” and presses Enter.
- **Then** The address becomes http://foo:81/.

## browser-address-search-033

Original test `The address bar resolves input foo:80/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “foo:80/path” and presses Enter.
- **Then** The address becomes http://foo/path.

## browser-address-search-034

Original test `The address bar resolves input 2130706433:81`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “2130706433:81” and presses Enter.
- **Then** The address becomes http://127.0.0.1:81/.

## browser-address-search-035

Original test `The address bar resolves input foo:99999`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** A remote browser is open.
- **When** The user enters “foo:99999” and presses Enter.
- **Then** The address becomes https://www.google.com/search?q=foo%3A99999.

## browser-address-search-036

Original test `The address bar resolves input localhost:8080/path`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “localhost:8080/path.”
- **When** The user presses Enter.
- **Then** The address resolves to http://localhost:8080/path.

## browser-address-search-037

Original test `The address bar resolves input foo.localhost`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “foo.localhost.”
- **When** The user presses Enter.
- **Then** The address resolves to http://foo.localhost/.

## browser-address-search-038

Original test `The address bar resolves input printer.local`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “printer.local.”
- **When** The user presses Enter.
- **Then** The address resolves to http://printer.local/.

## browser-address-search-039

Original test `The address bar resolves input 127.0.0.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “127.0.0.1.”
- **When** The user presses Enter.
- **Then** The address resolves to http://127.0.0.1/.

## browser-address-search-040

Original test `The address bar resolves input 127.0.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “127.0.1.”
- **When** The user presses Enter.
- **Then** The input is treated as a Google search and resolves to https://www.google.com/search?q=127.0.1.

## browser-address-search-041

Original test `The address bar resolves input 0x7f.0.0.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “0x7f.0.0.1.”
- **When** The user presses Enter.
- **Then** The address resolves to http://127.0.0.1/.

## browser-address-search-042

Original test `The address bar resolves input http://0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “http://0.”
- **When** The user presses Enter.
- **Then** The input is treated as a Google search and resolves to https://www.google.com/search?q=http%3A%2F%2F0.

## browser-address-search-043

Original test `The address bar resolves input http://0.0.0.0`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “http://0.0.0.0.”
- **When** The user presses Enter.
- **Then** The address resolves to http://0.0.0.0/.

## browser-address-search-044

Original test `The address bar resolves input .127.0.0.1/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “.127.0.0.1/.”
- **When** The user presses Enter.
- **Then** The address resolves to http://127.0.0.1/.

## browser-address-search-045

Original test `The address bar resolves input .1.2/`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “.1.2/.”
- **When** The user presses Enter.
- **Then** The address resolves to http://1.0.0.2/.

## browser-address-search-046

Original test `The address bar resolves input [2001:db8::2]`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “[2001:db8::2].”
- **When** The user presses Enter.
- **Then** The address resolves to http://[2001:db8::2]/.

## browser-address-search-047

Original test `The address bar resolves input https;//example.com/report?q=1#total`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “https;//example.com/report?q=1#total.”
- **When** The user presses Enter.
- **Then** The address resolves to https://example.com/report?q=1#total.

## browser-address-search-048

Original test `The address bar resolves input https:/example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “https:/example.com.”
- **When** The user presses Enter.
- **Then** The address resolves to https://example.com/.

## browser-address-search-049

Original test `The address bar resolves input ..example.com..`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “..example.com..”.
- **When** The user presses Enter.
- **Then** The address resolves to http://example.com./.

## browser-address-search-050

Original test `The address bar resolves input http://foo._`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “http://foo._.”
- **When** The user presses Enter.
- **Then** The input is treated as a Google search and resolves to https://www.google.com/search?q=http%3A%2F%2Ffoo._.

## browser-address-search-051

Original test `The address bar resolves input https://%2eexample.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “https://%2eexample.com.”
- **When** The user presses Enter.
- **Then** The input is treated as a Google search and resolves to https://www.google.com/search?q=https%3A%2F%2F%252eexample.com.

## browser-address-search-052

Original test `The address bar resolves input aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains a host of 63 “a” characters followed by “.com.”
- **When** The user presses Enter.
- **Then** The address resolves to that host over HTTP with a trailing slash.

## browser-address-search-053

Original test `The address bar resolves input aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains a host of 64 “a” characters followed by “.com.”
- **When** The user presses Enter.
- **Then** The input is treated as a Google search, with the full input encoded in the query.

## browser-address-search-054

Original test `The address bar resolves input wss://example.invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “wss://example.invalid.”
- **When** The user presses Enter.
- **Then** The address resolves to wss://example.invalid/.

## browser-address-search-055

Original test `The address bar resolves input example.com\report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “example.com\report.”
- **When** The user presses Enter.
- **Then** The address resolves to http://example.com/report.

## browser-address-search-056

Original test `The address bar resolves input 例子.中国/季度报告`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L309).

- **Given** The address bar contains “例子.中国/季度报告.”
- **When** The user presses Enter.
- **Then** The address resolves to http://xn--fsqu00a.xn--fiqs8s/%E5%AD%A3%E5%BA%A6%E6%8A%A5%E5%91%8A.

## browser-address-search-057

Original test `Ctrl+Enter completes eligible host input acmeportal`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “acmeportal.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.acmeportal.com/.

## browser-address-search-058

Original test `Ctrl+Enter completes eligible host input acmeportal/report part?q=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “acmeportal/report part?q=1.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.acmeportal.com/report%E2%80%A9part?q=1.

## browser-address-search-059

Original test `Ctrl+Enter completes eligible host input www`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “www.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.com/.

## browser-address-search-060

Original test `Ctrl+Enter completes eligible host input www.acmeportal/report?q=a#summary`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “www.acmeportal/report?q=a#summary.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.acmeportal.com/report?q=a#summary.

## browser-address-search-061

Original test `Ctrl+Enter completes eligible host input example.co.uk/report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “example.co.uk/report.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://example.co.uk/report.

## browser-address-search-062

Original test `Ctrl+Enter completes eligible host input co.uk`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “co.uk.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.co.uk.com/.

## browser-address-search-063

Original test `Ctrl+Enter completes eligible host input example..com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “example..com.”
- **When** The user presses Ctrl+Enter.
- **Then** The input is treated as a Google search and resolves to https://www.google.com/search?q=example..com.

## browser-address-search-064

Original test `Ctrl+Enter completes eligible host input portal.invalid`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “portal.invalid.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.portal.invalid.com/.

## browser-address-search-065

Original test `Ctrl+Enter completes eligible host input 999999999999999`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “999999999999999.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://www.999999999999999.com/.

## browser-address-search-066

Original test `Ctrl+Enter completes eligible host input https://127.0.1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “https://127.0.1.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to https://www.127.0.1.com/.

## browser-address-search-067

Original test `Ctrl+Enter completes eligible host input https:65536`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “https:65536.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to https://www.65536.com/.

## browser-address-search-068

Original test `Ctrl+Enter completes eligible host input ..example.com..`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “..example.com..”.
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://example.com./.

## browser-address-search-069

Original test `Ctrl+Enter completes eligible host input 例子.中国`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “例子.中国.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to http://xn--fsqu00a.xn--fiqs8s/.

## browser-address-search-070

Original test `Ctrl+Enter completes eligible host input aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains a host of 64 “a” characters followed by “.com.”
- **When** The user presses Ctrl+Enter.
- **Then** The address resolves to that host over HTTP with a trailing slash.

## browser-address-search-071

Original test `Ctrl+Enter completes eligible host input aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains a host over 63 characters in a label, with four 63-character labels before .com.
- **When** The user presses Ctrl+Enter.
- **Then** The address is opened with an http:// prefix, without a www. prefix or Google search.

## browser-address-search-072

Original test `Ctrl+Enter completes eligible host input https://example.com/report?q=1#total`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains https://example.com/report?q=1#total.
- **When** The user presses Ctrl+Enter.
- **Then** The address remains that exact URL; no search or domain suffix is added.

## browser-address-search-073

Original test `Ctrl+Enter completes eligible host input annual report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains the plain-text query “annual report.”
- **When** The user presses Ctrl+Enter.
- **Then** The query opens as a Google search for “annual report.”

## browser-address-search-074

Original test `Ctrl+Enter completes eligible host input site:example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “site:example.com.”
- **When** The user presses Ctrl+Enter.
- **Then** The text opens as a Google search, with the colon encoded in the query.

## browser-address-search-075

Original test `Ctrl+Enter completes eligible host input filetype:pdf annual report`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “filetype:pdf annual report.”
- **When** The user presses Ctrl+Enter.
- **Then** The text opens as a Google search, with the colon encoded in the query.

## browser-address-search-076

Original test `Ctrl+Enter completes eligible host input ?example.com`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L354).

- **Given** The address bar contains “?example.com.”
- **When** The user presses Ctrl+Enter.
- **Then** The text opens as a Google search for “example.com,” omitting the leading question mark.

## browser-address-search-077

Original test `Pasted address text is sanitized before submission: https://example.com/a- report?q=1`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L384).

- **Given** The address bar contains “replace me,” selected, and the clipboard contains “https://example.com/a-” followed by a newline and “report?q=1.”
- **When** The user pastes the clipboard text and presses Enter.
- **Then** The pasted newline is removed, leaving and opening https://example.com/a-report?q=1. The caret is at the end of the cleaned text before submission.

## browser-address-search-078

Original test `Pasted address text is sanitized before submission: 1600 Amphitheatre Parkway Mountain View, CA`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L384).

- **Given** The address bar contains “replace me,” selected, and the clipboard contains “1600 Amphitheatre Parkway” followed by a newline and “Mountain View, CA.”
- **When** The user pastes the clipboard text and presses Enter.
- **Then** The newline becomes a space, and the cleaned text opens as a Google search for “1600 Amphitheatre Parkway Mountain View, CA.” The caret is at the end of the cleaned text before submission.

## browser-address-search-079

Original test `Pasted address text is sanitized before submission: java script:JavaScript:alert(0)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L384).

- **Given** The address bar contains “replace me,” selected, and the clipboard contains whitespace around “java” followed by CRLF and “script:JavaScript:alert(0).”
- **When** The user pastes the clipboard text and presses Enter.
- **Then** The cleaned address text is “alert(0),” which opens as a Google search for alert(0). The caret is at the end of the cleaned text before submission.

## browser-address-search-080

Original test `Pasted address text is sanitized before submission: https://example.com/?q=javascript:alert(0)`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L384).

- **Given** The address bar contains “replace me,” selected, and the clipboard contains “https://example.com/?q=javascript:alert(0).”
- **When** The user pastes the clipboard text and presses Enter.
- **Then** The address remains unchanged after paste and opens as https://example.com/?q=javascript:alert(0). The caret is at the end of the pasted text before submission.

## browser-address-search-081

Original test `Sanitized paste replaces the selected address text and retains its caret`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L402).

- **Given** The address bar contains “first old last,” with “old” selected, and the clipboard contains “javascript:javascript:NEW.”
- **When** The user pastes the clipboard text and presses Enter.
- **Then** The selected text is replaced, yielding “first NEW last,” and the caret remains immediately after “NEW.” The full text opens as a Google search for “first NEW last.”

## browser-address-search-082

Original test `A consumed Control gesture submits the query without adding a domain suffix`. [Registration](https://github.com/okou-ai/okou/blob/b0a10287edf4242383c28e39c6f7675053febb32/turbo/apps/platform/src/views/browser-session/__tests__/browser-address-search.test.tsx#L420).

- **Given** The address bar contains “acmeportal,” and the user selects all of its text while holding Control.
- **When** The user presses Enter as part of that Control gesture.
- **Then** The text opens as a Google search for “acmeportal”; no domain suffix is added.
