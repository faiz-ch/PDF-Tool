export type Rotation = 0 | 90 | 180 | 270;

/** One uploaded file, normalised to PDF bytes (images are converted on upload). */
export interface Source {
  id: string;
  name: string;
  bytes: Uint8Array;
  pageCount: number;
}

/** One page in the shared page pool. Groups reference pages by id. */
export interface PageItem {
  id: string;
  sourceId: string;
  sourceName: string;
  pageIndex: number; // zero-based index inside its source PDF
  rotation: Rotation; // extra rotation applied by the user
  thumb?: string; // object URL of the rendered thumbnail
  thumbError?: boolean; // rendering failed
  aspect: number; // height / width, for placeholder sizing
}

/** Size limit: 'default' follows the global limit, null means no limit, number is MB. */
export type LimitSetting = 'default' | null | number;

export interface Group {
  id: string;
  name: string;
  pageIds: string[];
  limit: LimitSetting;
}

export type ResultStatus = 'ok' | 'compressed' | 'over-limit' | 'error';

export interface GroupResult {
  groupId: string;
  fileName: string;
  blob?: Blob;
  originalSize: number;
  finalSize: number;
  limitBytes: number | null;
  status: ResultStatus;
  message?: string;
}
