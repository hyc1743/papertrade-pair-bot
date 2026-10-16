/** An explicit one-off UTC instant; never infer a date or roll over to tomorrow. */
export function parseOpeningAt(value:string):number {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    throw new Error('openingAtUtc 必须是带日期的 UTC 时间，例如 2026-10-10T14:00:00Z');
  const timestamp=Date.parse(value);
  const canonical=value.includes('.')?value:value.replace('Z','.000Z');
  if(!Number.isFinite(timestamp)||new Date(timestamp).toISOString()!==canonical)
    throw new Error('openingAtUtc 日期或时间无效');
  return timestamp;
}
export function openingSchedule(value:string|null,leadMs:number,now:number) {
  const openingAt=value===null?null:parseOpeningAt(value);
  const checkAt=openingAt===null?null:openingAt-leadMs;
  return {openingAt,checkAt,canCheck:checkAt===null||now>=checkAt,canOpen:openingAt===null||now>=openingAt};
}
