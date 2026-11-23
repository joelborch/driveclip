export const SHARE_BASE = 'https://videos.dentistrybrandsllc.com/v/';
export const FOLDER_NAME = 'DriveClip Recordings';
export const APP_PROPERTY = { driveclip: 'root-folder' };
export const TIMESLICE_MS = 3000;
export const UPLOAD_GRANULARITY = 256 * 1024;              // Drive resumable chunk alignment (256 KiB)
export const UPLOAD_SLICE_BYTES = UPLOAD_GRANULARITY * 16; // 4 MiB per resumable PUT
export const PENDING_FILE_NAME = 'pending-recording.webm';
