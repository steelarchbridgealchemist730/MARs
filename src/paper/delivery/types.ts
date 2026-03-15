export type DeliveryFormat = 'arxiv' | 'camera-ready' | 'standard'

export interface DeliveryOptions {
  format?: DeliveryFormat
  include_code?: boolean
  output_dir?: string
  /** If false, skip git commit/tag. Defaults to true. */
  git_tag?: boolean
}

export interface DeliveryManifest {
  created_at: string
  format: DeliveryFormat
  files: Array<{ path: string; description: string }>
  paper_title: string
  pdf_path: string
  source_dir: string
}
