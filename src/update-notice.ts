/** The update notice's words, shared by the server page and the console. Plain text; callers escape. */
export function updateNoticeWords(notice: { version: string; security: boolean }): string {
  return notice.security ? `Toolroll ${notice.version} is available, with security fixes` : `Toolroll ${notice.version} is available`;
}
