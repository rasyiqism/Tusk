import { withMermaid } from "vitepress-plugin-mermaid";

function rewriteIncludedRepoLink(href: string): string {
  if (href.startsWith("docs/")) {
    return "/" + href.slice(5).replace(/\.md(#.*)?$/, "$1");
  }
  if (/^README\.md(#.*)?$/i.test(href)) {
    return "/" + href.replace(/^README\.md/i, "");
  }
  const rootMd = href.match(/^(CHANGELOG|SECURITY|CONTRIBUTING)\.md(#.*)?$/i);
  if (rootMd) {
    return `/${rootMd[1]!.toLowerCase()}${rootMd[2] || ""}`;
  }
  return href;
}

export default withMermaid({
  title: "Tusk",
  description: "Lightweight, zero-bloat self-hosted PostgreSQL Control Panel",
  base: "/Tusk/",
  appearance: "dark",
  cleanUrls: true,
  lastUpdated: true,

  markdown: {
    config: (md) => {
      md.core.ruler.after("inline", "rewrite-tusk-root-links", (state) => {
        for (const token of state.tokens) {
          if (token.type !== "inline" || !token.children) continue;
          for (const child of token.children) {
            if (child.type !== "link_open") continue;
            const hrefIdx = child.attrIndex("href");
            if (hrefIdx < 0) continue;
            const current = child.attrs![hrefIdx]![1];
            child.attrs![hrefIdx]![1] = rewriteIncludedRepoLink(current);
          }
        }
      });
    },
  },

  themeConfig: {
    siteTitle: "Tusk",
    nav: [
      { text: "Home", link: "/" },
      { text: "Deployment", link: "/DEPLOYMENT" },
      { text: "Architecture", link: "/ARCHITECTURE" },
      { text: "API", link: "/API" },
      { text: "Changelog", link: "/changelog" },
    ],

    sidebar: [
      {
        text: "Getting Started",
        items: [
          { text: "Overview", link: "/" },
          { text: "Production Deployment & Scaling", link: "/DEPLOYMENT" },
        ],
      },
      {
        text: "Technical Reference",
        items: [
          { text: "System Architecture", link: "/ARCHITECTURE" },
          { text: "HTTP & SSE API Reference", link: "/API" },
        ],
      },
      {
        text: "Project & Governance",
        items: [
          { text: "Security Policy", link: "/security" },
          { text: "Contributing", link: "/contributing" },
          { text: "Changelog", link: "/changelog" },
        ],
      },
    ],

    search: {
      provider: "local",
    },

    socialLinks: [
      { icon: "github", link: "https://github.com/rasyiqism/Tusk" },
    ],

    footer: {
      message: "Released under the MIT License.",
      copyright: "Tusk PostgreSQL Control Panel",
    },
  },
});
