# LiquidJS Built-in Filters

Standard filters available in all `.tpl.` files. Chained with `|`.

## String

| Filter | Description | Example |
|:-------|:------------|:--------|
| `upcase` | Uppercase | `{{ "hello" | upcase }}` → `HELLO` |
| `downcase` | Lowercase | `{{ "HELLO" | downcase }}` → `hello` |
| `capitalize` | First char uppercase | `{{ "hello world" | capitalize }}` → `Hello world` |
| `strip` | Remove leading/trailing whitespace | `{{ "  hi  " | strip }}` → `hi` |
| `lstrip` | Remove leading whitespace | |
| `rstrip` | Remove trailing whitespace | |
| `strip_newlines` | Remove all newlines | |
| `strip_html` | Remove HTML tags | |
| `escape` | HTML-escape `<`, `>`, `&`, `"` | |
| `url_encode` | Percent-encode a URL string | |
| `url_decode` | Decode a percent-encoded string | |
| `append` | Append a string | `{{ "foo" | append: "bar" }}` → `foobar` |
| `prepend` | Prepend a string | `{{ "bar" | prepend: "foo" }}` → `foobar` |
| `replace` | Replace all occurrences | `{{ "aabbcc" | replace: "b", "x" }}` → `aaxxcc` |
| `replace_first` | Replace first occurrence | |
| `remove` | Remove all occurrences | `{{ "aabbcc" | remove: "b" }}` → `aacc` |
| `remove_first` | Remove first occurrence | |
| `truncate` | Truncate to N chars (adds `...`) | `{{ "hello world" | truncate: 7 }}` → `hell...` |
| `truncatewords` | Truncate to N words | `{{ "one two three" | truncatewords: 2 }}` → `one two...` |
| `split` | Split string into array | `{{ "a,b,c" | split: "," }}` → `["a","b","c"]` |
| `newline_to_br` | Replace `\n` with `<br>` | |

## Array

| Filter | Description | Example |
|:-------|:------------|:--------|
| `join` | Join array with separator | `{{ arr | join: ", " }}` |
| `first` | First element | `{{ arr | first }}` |
| `last` | Last element | `{{ arr | last }}` |
| `reverse` | Reverse order | |
| `sort` | Sort ascending (case-sensitive) | |
| `sort_natural` | Sort ascending (case-insensitive) | |
| `uniq` | Remove duplicates | |
| `compact` | Remove nil/falsy values | |
| `map` | Extract a property from each object | `{{ items | map: "name" }}` |
| `where` | Filter objects by property value | `{{ items | where: "active", true }}` |
| `concat` | Concatenate two arrays | `{{ arr1 | concat: arr2 }}` |
| `slice` | Extract a sub-array | `{{ arr | slice: 1, 3 }}` |
| `size` | Length of string or array | `{{ arr | size }}` |
| `push` | Append element to array | |
| `pop` | Remove last element | |
| `shift` | Remove first element | |
| `unshift` | Prepend element to array | |

## Number

| Filter | Description | Example |
|:-------|:------------|:--------|
| `plus` | Add | `{{ 4 | plus: 2 }}` → `6` |
| `minus` | Subtract | `{{ 4 | minus: 2 }}` → `2` |
| `times` | Multiply | `{{ 4 | times: 2 }}` → `8` |
| `divided_by` | Divide | `{{ 10 | divided_by: 2 }}` → `5` |
| `modulo` | Modulus | `{{ 10 | modulo: 3 }}` → `1` |
| `abs` | Absolute value | `{{ -4 | abs }}` → `4` |
| `ceil` | Round up | `{{ 4.1 | ceil }}` → `5` |
| `floor` | Round down | `{{ 4.9 | floor }}` → `4` |
| `round` | Round to nearest (or N decimal places) | `{{ 4.567 | round: 2 }}` → `4.57` |
| `at_least` | Clamp to minimum | `{{ 3 | at_least: 5 }}` → `5` |
| `at_most` | Clamp to maximum | `{{ 7 | at_most: 5 }}` → `5` |

## Other

| Filter | Description | Example |
|:-------|:------------|:--------|
| `default` | Fallback if nil/empty/false | `{{ val | default: "n/a" }}` |
| `date` | Format a date | `{{ "now" | date: "%Y-%m-%d" }}` |
| `size` | Length of string or array | `{{ "hello" | size }}` → `5` |
| `json` | Serialize to JSON string | `{{ obj | json }}` |

## Sous Custom Filters

| Filter | Description |
|:-------|:------------|
| `bulletList` | Convert array to markdown bullet list (`- item` per line) |
