// DriveClip shared configuration constants.
// Replace SHARE_BASE with your deployed dashboard base URL (must end with a slash).

export const SHARE_BASE = 'https://videos.dentistrybrandsllc.com/v/'; // dashboard base URL
export const FOLDER_NAME = 'DriveClip Recordings';
export const APP_PROPERTY = { driveclip: 'root-folder' };    // marks our folder
export const TIMESLICE_MS = 3000;
export const UPLOAD_GRANULARITY = 256 * 1024;                // Drive chunk multiple
export const UPLOAD_SLICE_BYTES = UPLOAD_GRANULARITY * 16;   // 4 MiB per PUT
