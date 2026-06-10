# `@p10agency/banner-build`

CLI for building multi-variant HTML banner projects from a small, repeatable project structure.

It is designed for banner work that has:

- multiple sizes
- optional alternate message variants
- shared assets and shared partials
- per-size static images
- a reviewable `dist/` output with zipped deliverables

## Install

```bash
npm install --save-dev @p10agency/banner-build
```

This package exposes the CLI command:

```bash
banner-build
```

Most projects will run it through the local npm bin path:

```bash
./node_modules/.bin/banner-build
```

## CLI

Build a single banner project:

```bash
banner-build .
```

Build every immediate subdirectory that contains a `creative.config.json`:

```bash
banner-build ./path/to/workspace
```

Run asset linting instead of a build:

```bash
banner-build . --lint-assets
```

Watch a single project and rebuild on change:

```bash
banner-build . --watch
```

Show help:

```bash
banner-build --help
```

## Project layout

Each banner project is expected to look like this:

```text
my-banner/
  creative.config.json
  index.ejs
  css/
    styles-300x250.scss
    styles-728x90.scss
  js/
    main.js
  images/
    ...
```

The required pieces are:

- `creative.config.json`
- `index.ejs`

The build also expects these conventions unless overridden by config:

- stylesheets live in `css/`
- JavaScript entry files live in `js/`
- image assets live in `images/`

## Configuration

The build is driven by `creative.config.json`.

At a high level, the config supports:

- `campaign_title`
- `globals`
- `sizes`
- `alts`

Example:

```json
{
  "campaign_title": "Example Campaign",
  "globals": {
    "static_name": "static.jpg",
    "vars": {
      "static_job_code": "JOB-12345",
      "click_tag": "https://example.com"
    }
  },
  "sizes": [
    {
      "id": "300x250",
      "width": 300,
      "height": 250,
      "stylesheet": "styles-300x250.css",
      "javascript": "main.js",
      "static": "static-300x250.jpg"
    },
    {
      "id": "728x90",
      "width": 728,
      "height": 90,
      "stylesheet": "styles-728x90.css",
      "javascript": "main.js",
      "static": "static-728x90.jpg"
    }
  ],
  "alts": [
    {
      "id": "A",
      "headline": "Primary message"
    },
    {
      "id": "B",
      "headline": "Alternate message"
    }
  ]
}
```

## Sizes

Each object in `sizes` describes one output variant.

Supported fields:

- `id`
- `width`
- `height`
- `stylesheet`
- `javascript`
- `static`
- `static_job_code`
- `image`

### Dynamic sizes

A normal size generates a full banner output in `dist/`.

Typical fields:

- `id`: a label like `300x250`
- `width`
- `height`
- `stylesheet`: output CSS filename, usually mapped to an SCSS entry
- `javascript`: output JS filename, usually mapped to a JS entry
- `static`: static image source for that size
- `static_job_code`: optional override for the statics-zip filename prefix for this size

If `stylesheet` is omitted, the build assumes `styles-${id}.css`.

If `javascript` is omitted, the build assumes `main.js`.

### Image-only sizes

If a size includes:

```json
{ "image": true }
```

it is treated as a static-only size. It will not produce a full dynamic banner variant, but its static can still be included in the generated statics zip.

## Alts

`alts` lets you create alternate banner variants from the same size set.

Each alt must have:

- `id`

Additional fields are merged into template variables and can be referenced in `index.ejs`.

For each alt + size combination, the output directory name is:

```text
<project>-<alt-id>-<size-id>
```

Without alts, the output directory name is:

```text
<project>-<size-id>
```

### Alt-specific CSS

The builder supports pruning alt-specific CSS blocks based on the active alt id.

Patterns like these are recognized:

```scss
.alt-A {
  ...
}

&.alt-B {
  ...
}
```

Only the matching alt block is kept in the generated CSS for that variant.

### Alt-specific statics

An alt may define its own `static`, but only when the project has exactly one dynamic size.

If multiple dynamic sizes are configured, alt-level `static` is rejected.

## Globals and template variables

`globals` can provide shared settings and shared template variables.

The builder merges:

- top-level `globals`
- `globals.vars`
- alt fields
- size fields relevant to rendering

The template receives:

- `size`
- `alt`
- `vars`
- `title`

In addition, the builder injects:

- `vars.alt_id`
- `vars.body_class`
- `vars.banner_width`
- `vars.banner_height`

## Templates

HTML is rendered from `index.ejs`.

Supported EJS features in this builder:

- `<%= ... %>` escaped output
- `<%- ... %>` unescaped output
- `<% ... %>` logic blocks
- `include('path', locals)`

Includes are resolved relative to the file that calls `include`.

## Stylesheets

The builder compiles SCSS by inlining `@import` statements.

Resolution rules:

- imports may omit `.scss`
- underscore-prefixed partials are supported
- stylesheet entries are resolved from the project root or `css/`

Important limitation:

- this is not a full Sass compiler
- it only handles the import-inlining workflow used by these banner projects

## JavaScript

JavaScript entry files are concatenated by inlining imports.

Resolution rules:

- entry files are resolved from the project root or `js/`
- relative imports are supported

Important limitation:

- only side-effect imports are supported
- `import './module.js'` is supported
- named/default imports such as `import foo from './foo.js'` are rejected

## Images and static assets

The builder scans rendered HTML and CSS for image references, copies the referenced files into each output directory, and rewrites references to flattened output filenames where needed.

Supported referenced asset formats:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`
- `.svg`
- `.webp`
- `.avif`

### Static image rules

Per-size static images are separate from general referenced assets.

Static images must be one of:

- `.png`
- `.jpg`
- `.jpeg`
- `.gif`

Static image sources can be defined in this priority order:

1. alt `static` when exactly one dynamic size exists
2. size `static`
3. `globals.vars.static`
4. `globals.static`

The output static filename defaults to:

```text
static.jpg
```

You can override it with:

```json
{
  "globals": {
    "static_name": "my-static.jpg"
  }
}
```

For the optional project statics zip, filename collisions are normally resolved by prefixing each static with the variant output folder name such as:

```text
my-banner-300x250-static.jpg
```

You can override the project-name portion of that prefix with `static_job_code`. When present, the statics zip always uses the prefixed name even if the original static filenames are already unique. The value can be defined on `size`, `alt`, `globals.vars`, or `globals`, in that priority order.

Example:

```json
{
  "globals": {
    "vars": {
      "static_job_code": "TYM-US-05348"
    }
  }
}
```

For a project named `TYM-US-07037`, that produces statics-zip names like:

```text
TYM-US-05348-160x600-static.jpg
```

### Static resizing

If a static image is larger than the target banner size but scaled as a uniform integer multiple, the builder will resize it down to the expected dimensions.

Examples:

- `300x250` source for `300x250` target: accepted
- `600x500` source for `300x250` target: accepted and resized
- `450x375` source for `300x250` target: rejected
- `600x250` source for `300x250` target: rejected

## Output

Each build creates a `dist/` directory containing:

- one output folder per generated variant
- one zip per generated variant
- `index.html` preview page
- optional `<project>-statics.zip`

Each output folder contains flattened runtime assets, including:

- `index.html`
- compiled CSS
- compiled JS
- copied referenced images
- the resolved static image

### Dist preview

The generated `dist/index.html` contains:

- a preview grid grouped by alt
- links to each banner variant
- download links for variant zips
- frame links when the JavaScript contains GSAP-style labels like `frame1`, `frame2`, and so on

## Linting

`banner-build . --lint-assets` performs a project lint pass without building deliverables.

It reports:

- missing image references
- image filename collisions after flattening
- unused files in `images/`
- static image dimension issues
- clickTag setup issues

### ClickTag check

The lint currently requires:

```js
var clickTag = ...
```

to appear in the rendered HTML.

### Static dimension check

The lint accepts:

- exact static dimensions
- uniform integer multiples of the target size

## Watch mode

`--watch` rebuilds a single project when input files change.

Watched extensions:

- `.js`
- `.ejs`
- `.scss`
- `.json`
- `.png`
- `.jpg`
- `.jpeg`
- `.svg`
- `.gif`
- `.webp`

Ignored directories:

- `dist`
- `.git`
- `node_modules`

## Workspace mode

If you point `banner-build` at a directory that does not itself contain a `creative.config.json`, it scans immediate subdirectories and builds every one that does.

This is useful for a repo that contains multiple banner projects side by side.

## Practical example

Build one project:

```bash
cd my-banner
npx banner-build .
```

Lint one project:

```bash
npx banner-build . --lint-assets
```

Build all projects in a workspace:

```bash
npx banner-build ./campaigns
```

Watch one project:

```bash
npx banner-build . --watch
```
