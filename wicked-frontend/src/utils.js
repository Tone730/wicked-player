export async function fetchJson(url, opt={}) {
  const r = await fetch(url, opt);
  const j = await r.json();
  if (!r.ok) throw new Error(j.msg || "HTTP error");
  return j;
}
