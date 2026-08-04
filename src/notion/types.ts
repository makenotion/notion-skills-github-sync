// A file entry on a Notion "Files" property (Notion-hosted or external). The
// URL is a short-lived signed URL for Notion-hosted uploads.
export interface NotionFileRef {
  name: string;
  url: string;
}

// A single skill page pulled from the Notion "Cowork Skills" database.
export interface NotionSkillPage {
  pageId: string;
  /** Raw "Skill name" title (may have stray whitespace — slugify downstream). */
  name: string;
  /** "Description" rich_text, may be empty. */
  description: string;
  /** Whether the "Published" checkbox is checked. */
  published: boolean;
  /** "Created by" display name, best-effort. */
  createdBy: string;
  /** ISO timestamp of last edit, used for change detection / logging. */
  lastEditedTime: string;
  /**
   * "Plugins" multi-select values — the plugin(s) this skill is published
   * into. Empty means untagged; the sync falls back to a catch-all plugin.
   */
  plugins: string[];
  /** Files attached to the "Files" property (optional; we unpack a single zip). */
  files?: NotionFileRef[];
}

// Abstraction over how we talk to Notion. The default implementation shells out
// to the `ntn` CLI; a direct-REST implementation can be added for serverless.
export interface NotionClient {
  /** List every row in the data source (caller filters for `published`). */
  listSkillPages(): Promise<NotionSkillPage[]>;
  /** Fetch a page body as Markdown (no Notion frontmatter). */
  getPageBodyMarkdown(pageId: string): Promise<string>;
  /**
   * Map each "Plugins" option name to its description, read from the data
   * source schema. Options without a description are omitted. Used to give a
   * grouped plugin a description in the external clients.
   */
  getPluginDescriptions(): Promise<Map<string, string>>;
}
