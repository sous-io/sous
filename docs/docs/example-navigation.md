# Links and navigation

?> This is an example page. It shows how routing, deep links, and search behave; it will be
replaced by real reference content.

## Deep links

Every page has a stable hash URL (`#/example-navigation`), and every heading gets an anchor
(`#/example-navigation?id=deep-links`). Both survive refresh and can be shared; click any
heading on this page and watch the address bar.

## Cross-page links

Plain relative markdown links route client-side without a page reload:

- [Code blocks](example-code.md)
- [Straight to the YAML section](example-code.md?id=yaml)
- [Back to the overview](/)

External links behave normally:

- [The Sous repository](https://github.com/sous-io/sous)
- [`@sous-io/sous` on npm](https://www.npmjs.com/package/@sous-io/sous)

## The sidebar

The sidebar is one markdown file, `_sidebar.md`. The active page is highlighted, and its own
second-level headings appear nested beneath it; look left, this page's sections are listed
there right now.

## Search

The search box above the sidebar indexes every page client-side. Try typing `liquid` or
`precedence`; results link straight to the matching section.
