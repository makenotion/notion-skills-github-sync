// A file entry on a Notion "Files" property (Notion-hosted or external). The
// URL is a short-lived signed URL for Notion-hosted uploads.
export interface NotionFileRef {
  name: string;
  url: string;
}
