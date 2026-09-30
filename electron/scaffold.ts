// Creates a minimal Astro starter project the visual builder can edit
// immediately: a base layout, a handful of components with typed props,
// and an index page.

import fs from 'fs';
import path from 'path';

const FILES: Record<string, (name: string) => string> = {
  'package.json': (name) =>
    JSON.stringify(
      {
        name,
        type: 'module',
        version: '0.0.1',
        scripts: {
          dev: 'astro dev',
          build: 'astro build',
          preview: 'astro preview',
        },
        dependencies: {
          astro: '^5.1.1',
        },
      },
      null,
      2,
    ) + '\n',

  'astro.config.mjs': () => `import { defineConfig } from 'astro/config';

export default defineConfig({});
`,

  '.gitignore': () => `node_modules/
dist/
.astro/
`,

  'src/layouts/BaseLayout.astro': () => `---
interface Props {
  title?: string;
  description?: string;
}
const { title = 'My Site', description = 'Built with Stacki' } = Astro.props;
---
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="description" content={description} />
    <title>{title}</title>
    <style is:global>
      * { box-sizing: border-box; margin: 0; }
      body {
        font-family: system-ui, -apple-system, sans-serif;
        color: #1a1a2e;
        background: #fdfdfd;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <slot />
  </body>
</html>
`,

  'src/components/Hero.astro': () => `---
interface Props {
  heading?: string;
  subheading?: string;
  ctaText?: string;
  ctaLink?: string;
}
const {
  heading = 'Welcome to your new site',
  subheading = 'Edit this hero in the visual builder.',
  ctaText = 'Get Started',
  ctaLink = '#',
} = Astro.props;
---
<section style="padding: 6rem 2rem; text-align: center; \
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white;">
  <h1 style="font-size: 3rem; margin-bottom: 1rem;">{heading}</h1>
  <p style="font-size: 1.25rem; opacity: 0.9; margin-bottom: 2rem;">{subheading}</p>
  <a href={ctaLink} style="display: inline-block; padding: 0.75rem 2rem; background: white; \
color: #667eea; border-radius: 8px; text-decoration: none; font-weight: 600;">{ctaText}</a>
</section>
`,

  'src/components/Feature.astro': () => `---
interface Props {
  icon?: string;
  title?: string;
  description?: string;
}
const {
  icon = '✨',
  title = 'Feature title',
  description = 'Describe this feature here.',
} = Astro.props;
---
<div style="max-width: 640px; margin: 0 auto; padding: 2rem; display: flex; gap: 1rem; \
align-items: flex-start;">
  <div style="font-size: 2rem;">{icon}</div>
  <div>
    <h3 style="font-size: 1.25rem; margin-bottom: 0.25rem;">{title}</h3>
    <p style="color: #555;">{description}</p>
  </div>
</div>
`,

  'src/components/TextBlock.astro': () => `---
interface Props {
  heading?: string;
  text?: string;
  align?: string;
}
const {
  heading = '',
  text = 'Write something here.',
  align = 'left',
} = Astro.props;
---
<section style={\`max-width: 720px; margin: 0 auto; padding: 3rem 2rem; text-align: \${align};\`}>
  {heading && <h2 style="font-size: 2rem; margin-bottom: 1rem;">{heading}</h2>}
  <p style="font-size: 1.05rem; color: #444;">{text}</p>
</section>
`,

  'src/components/Spacer.astro': () => `---
interface Props {
  height?: number;
}
const { height = 48 } = Astro.props;
---
<div style={\`height: \${height}px;\`}></div>
`,

  'src/components/Footer.astro': () => `---
interface Props {
  text?: string;
}
const { text = '© 2026 My Site. All rights reserved.' } = Astro.props;
---
<footer style="padding: 3rem 2rem; text-align: center; color: #888; \
border-top: 1px solid #eee; margin-top: 4rem;">
  <p>{text}</p>
</footer>
`,

  'src/pages/index.astro': () => `---
import BaseLayout from '../layouts/BaseLayout.astro';
import Hero from '../components/Hero.astro';
import Feature from '../components/Feature.astro';
import Footer from '../components/Footer.astro';
---
<BaseLayout title="Home">
  <Hero heading="Welcome to your new site" \
subheading="Everything on this page is editable in the visual builder." />
  <Feature icon="🚀" title="Fast by default" \
description="Astro ships zero JavaScript unless you ask for it." />
  <Feature icon="🎨" title="Visually editable" \
description="Drag components, tweak props, and watch the preview update live." />
  <Footer />
</BaseLayout>
`,
};

function scaffoldProject(dir: string, name?: string): string {
  const safeName =
    (name || path.basename(dir))
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'astro-site';

  for (const [rel, gen] of Object.entries(FILES)) {
    const filePath = path.join(dir, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, gen(safeName), 'utf8');
  }
  return dir;
}

export { scaffoldProject };
