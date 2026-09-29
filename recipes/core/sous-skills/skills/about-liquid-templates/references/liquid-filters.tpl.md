# LiquidJS Built-in Filters

Standard filters available in all `.tpl.` files. Chained with `|`.

## String

| Filter | Description | Example |
|:-------|:------------|:--------|
| `upcase` | Uppercase | `{% raw %}{{ "hello" | upcase }}{% endraw %}` → `HELLO` |
| `downcase` | Lowercase | `{% raw %}{{ "HELLO" | downcase }}{% endraw %}` → `hello` |
| `capitalize` | First char uppercase | `{% raw %}{{ "hello world" | capitalize }}{% endraw %}` → `Hello world` |
| `strip` | Remove leading/trailing whitespace | `{% raw %}{{ "  hi  " | strip }}{% endraw %}` → `hi` |
| `lstrip` | Remove leading whitespace | |
| `rstrip` | Remove trailing whitespace | |
| `strip_newlines` | Remove all newlines | |
| `strip_html` | Remove HTML tags | |
| `escape` | HTML-escape `<`, `>`, `&`, `"` | |
| `url_encode` | Percent-encode a URL string | |
| `url_decode` | Decode a percent-encoded string | |
| `append` | Append a string | `{% raw %}{{ "foo" | append: "bar" }}{% endraw %}` → `foobar` |
| `prepend` | Prepend a string | `{% raw %}{{ "bar" | prepend: "foo" }}{% endraw %}` → `foobar` |
| `replace` | Replace all occurrences | `{% raw %}{{ "aabbcc" | replace: "b", "x" }}{% endraw %}` → `aaxxcc` |
| `replace_first` | Replace first occurrence | |
| `remove` | Remove all occurrences | `{% raw %}{{ "aabbcc" | remove: "b" }}{% endraw %}` → `aacc` |
| `remove_first` | Remove first occurrence | |
| `truncate` | Truncate to N chars (adds `...`) | `{% raw %}{{ "hello world" | truncate: 7 }}{% endraw %}` → `hell...` |
| `truncatewords` | Truncate to N words | `{% raw %}{{ "one two three" | truncatewords: 2 }}{% endraw %}` → `one two...` |
| `split` | Split string into array | `{% raw %}{{ "a,b,c" | split: "," }}{% endraw %}` → `["a","b","c"]` |
| `newline_to_br` | Replace `\n` with `<br>` | |

## Array

| Filter | Description | Example |
|:-------|:------------|:--------|
| `join` | Join array with separator | `{% raw %}{{ arr | join: ", " }}{% endraw %}` |
| `first` | First element | `{% raw %}{{ arr | first }}{% endraw %}` |
| `last` | Last element | `{% raw %}{{ arr | last }}{% endraw %}` |
| `reverse` | Reverse order | |
| `sort` | Sort ascending (case-sensitive) | |
| `sort_natural` | Sort ascending (case-insensitive) | |
| `uniq` | Remove duplicates | |
| `compact` | Remove nil/falsy values | |
| `map` | Extract a property from each object | `{% raw %}{{ items | map: "name" }}{% endraw %}` |
| `where` | Filter objects by property value | `{% raw %}{{ items | where: "active", true }}{% endraw %}` |
| `concat` | Concatenate two arrays | `{% raw %}{{ arr1 | concat: arr2 }}{% endraw %}` |
| `slice` | Extract a sub-array | `{% raw %}{{ arr | slice: 1, 3 }}{% endraw %}` |
| `size` | Length of string or array | `{% raw %}{{ arr | size }}{% endraw %}` |
| `push` | Append element to array | |
| `pop` | Remove last element | |
| `shift` | Remove first element | |
| `unshift` | Prepend element to array | |

## Number

| Filter | Description | Example |
|:-------|:------------|:--------|
| `plus` | Add | `{% raw %}{{ 4 | plus: 2 }}{% endraw %}` → `6` |
| `minus` | Subtract | `{% raw %}{{ 4 | minus: 2 }}{% endraw %}` → `2` |
| `times` | Multiply | `{% raw %}{{ 4 | times: 2 }}{% endraw %}` → `8` |
| `divided_by` | Divide | `{% raw %}{{ 10 | divided_by: 2 }}{% endraw %}` → `5` |
| `modulo` | Modulus | `{% raw %}{{ 10 | modulo: 3 }}{% endraw %}` → `1` |
| `abs` | Absolute value | `{% raw %}{{ -4 | abs }}{% endraw %}` → `4` |
| `ceil` | Round up | `{% raw %}{{ 4.1 | ceil }}{% endraw %}` → `5` |
| `floor` | Round down | `{% raw %}{{ 4.9 | floor }}{% endraw %}` → `4` |
| `round` | Round to nearest (or N decimal places) | `{% raw %}{{ 4.567 | round: 2 }}{% endraw %}` → `4.57` |
| `at_least` | Clamp to minimum | `{% raw %}{{ 3 | at_least: 5 }}{% endraw %}` → `5` |
| `at_most` | Clamp to maximum | `{% raw %}{{ 7 | at_most: 5 }}{% endraw %}` → `5` |

## Other

| Filter | Description | Example |
|:-------|:------------|:--------|
| `default` | Fallback if nil/empty/false | `{% raw %}{{ val | default: "n/a" }}{% endraw %}` |
| `date` | Format a date | `{% raw %}{{ "now" | date: "%Y-%m-%d" }}{% endraw %}` |
| `size` | Length of string or array | `{% raw %}{{ "hello" | size }}{% endraw %}` → `5` |
| `json` | Serialize to JSON string | `{% raw %}{{ obj | json }}{% endraw %}` |

## Sous Custom Filters

| Filter | Description |
|:-------|:------------|
| `bulletList` | Convert array to markdown bullet list (`- item` per line) |
