const MAX_BATCH = 20;
const CACHE_TTL = 86400; // 24 hours
const MAX_URL_LENGTH = 2048;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sitemap XML → CSV (ZIP)</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js"></script>
<style>
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;background:#f5f7fb;color:#172033}
.wrap{max-width:1050px;margin:30px auto;padding:0 16px}
.card{background:#fff;border:1px solid #e3e7ef;border-radius:16px;padding:22px;margin-bottom:16px;box-shadow:0 5px 20px #00000008}
h1{margin:0 0 8px;font-size:27px}
p{color:#596579}
label{font-weight:700;display:block;margin:14px 0 7px}
textarea{width:100%;min-height:210px;padding:13px;border:1px solid #ccd3df;border-radius:10px;font:14px ui-monospace,SFMono-Regular,Consolas,monospace;resize:vertical}
.row{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
button{border:0;border-radius:10px;padding:11px 16px;font-weight:700;cursor:pointer;background:#2563eb;color:white}
button.secondary{background:#e9eef7;color:#172033}
button.danger{background:#dc2626}
button:disabled{opacity:.5;cursor:not-allowed}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:10px}
.stat{background:#f7f9fc;border-radius:10px;padding:13px}
.stat b{display:block;font-size:22px}
.stat span{font-size:12px;color:#697386}
.bar{height:12px;background:#e6eaf1;border-radius:99px;overflow:hidden;margin:14px 0}
.bar>div{height:100%;width:0;background:#2563eb;transition:width .15s}
#log{max-height:340px;overflow:auto;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:#101827;color:#dbe5f5;padding:14px;border-radius:10px;white-space:pre-wrap}
.ok{color:#76e39a}
.err{color:#ff8f8f}
.muted{color:#697386}
.hint{font-size:13px}
.pill{display:inline-block;background:#eef4ff;color:#2457c5;padding:4px 8px;border-radius:99px;font-size:12px}
@media(max-width:700px){.stats{grid-template-columns:repeat(2,1fr)}}
</style>
</head>

<body>
<div class="wrap">

<div class="card">
<h1>📥 Sitemap XML → CSV (one ZIP)</h1>

<p>
Paste a sitemap index, an individual XML sitemap, or multiple sitemap URLs from any website.
The tool discovers child sitemaps automatically and processes them in small Cloudflare batches.
All CSVs are collected and downloaded as a single ZIP file at the end.
</p>

<label>Sitemap / sitemap-index URL(s)</label>

<textarea id="urls" placeholder="https://playboard.co/sitemap/channel/all/us.xml
https://example.com/sitemap.xml
https://example.com/sitemap_index.xml"></textarea>

<div class="row">
<button id="start">Start conversion → ZIP</button>
<button id="stop" class="danger" disabled>Stop</button>
<button id="clear" class="secondary">Clear</button>
</div>

<p class="hint">
<span class="pill">Batch size: ${MAX_BATCH}</span>
<span class="pill">All CSVs → one ZIP</span>
Each Worker invocation fetches at most ${MAX_BATCH} sitemap files.
Previously fetched sitemaps can be served from the Worker cache for 24 hours.
Any public HTTPS sitemap URL is accepted.
</p>
</div>

<div class="card">
<div class="stats">
<div class="stat"><b id="done">0</b><span>Sitemaps done</span></div>
<div class="stat"><b id="found">0</b><span>URLs extracted</span></div>
<div class="stat"><b id="created">0</b><span>CSV files created</span></div>
<div class="stat"><b id="failed">0</b><span>Failed</span></div>
</div>

<div class="bar"><div id="progress"></div></div>
<div id="status" class="muted">Ready.</div>
</div>

<div class="card">
<h3>Activity</h3>
<div id="log">Ready.</div>
</div>

</div>

<script>
let stopped=false;

const $=id=>document.getElementById(id);

function log(msg,cls=""){
  const d=document.createElement("div");
  d.className=cls;
  d.textContent=msg;
  $("log").appendChild(d);
  $("log").scrollTop=$("log").scrollHeight;
}

function safeName(n){
  return (n||"sitemap")
    .replace(/\\.xml$/i,"")
    .replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g,"-")
    .replace(/\\s+/g,"-")
    .slice(0,180)||"sitemap";
}

function csvEscape(v){
  return '"'+String(v??"").replace(/"/g,'""')+'"';
}

function makeCsvContent(urls){
  const lines=["url"];
  for(const u of urls)
    lines.push(csvEscape(u));
  return "\\uFEFF"+lines.join("\\r\\n")+"\\r\\n";
}

function extractLocs(xml){
  const trimmed = (xml||"").trim();
  if(!trimmed){
    throw new Error("Empty response from server");
  }
  // Detect HTML downtime / error pages
  if(/^<!DOCTYPE html/i.test(trimmed) || /<html[\\s>]/i.test(trimmed)){
    throw new Error("Server returned HTML instead of XML (site may be down, redirecting, or blocking bots)");
  }

  const doc=new DOMParser().parseFromString(xml,"application/xml");

  if(doc.querySelector("parsererror"))
    throw new Error("Invalid XML");

  const nodes=[...doc.getElementsByTagNameNS("*","loc")];
  const list=nodes.length
    ? nodes
    : [...doc.getElementsByTagName("loc")];

  const seen=new Set();
  const out=[];

  for(const n of list){
    const v=(n.textContent||"").trim();

    if(v&&!seen.has(v)){
      seen.add(v);
      out.push(v);
    }
  }

  return out;
}

function isSitemapIndex(xml){
  const doc=new DOMParser().parseFromString(xml,"application/xml");
  const roots=[...doc.children];

  return roots.some(r =>
    /sitemapindex$/i.test(r.localName||r.nodeName)
  ) || /<sitemapindex[\\s>]/i.test(xml);
}

async function downloadZip(files){
  if(!files.length){
    log("No CSV files to zip.","err");
    return;
  }

  if(typeof JSZip==="undefined"){
    log("JSZip library failed to load.","err");
    return;
  }

  const zip=new JSZip();
  for(const f of files){
    zip.file(f.name,f.content);
  }

  const blob=await zip.generateAsync({
    type:"blob",
    compression:"DEFLATE",
    compressionOptions:{level:6}
  });

  const objectUrl=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=objectUrl;
  a.download="sitemaps-"+new Date().toISOString().slice(0,19).replace(/[:T]/g,"-")+".zip";
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(()=>{
    URL.revokeObjectURL(objectUrl);
  },60000);

  log("📦 ZIP downloaded with "+files.length+" CSV file(s)","ok");
}

function urlName(url,i){
  try{
    const u=new URL(url);
    const p=u.pathname.split("/").filter(Boolean).pop()
      || ("sitemap-"+i);

    return safeName(p)+".csv";
  }catch{
    return "sitemap-"+i+".csv";
  }
}

function validChild(u){
  try{
    const x=new URL(u);
    return x.protocol==="https:" && u.length <= ${MAX_URL_LENGTH};
  }catch{
    return false;
  }
}

async function apiGet(url){
  const r=await fetch(
    "/api/sitemap?url="+encodeURIComponent(url)
  );

  if(!r.ok){
    let e="HTTP "+r.status;

    try{
      const j=await r.json();
      e=j.error||e;
    }catch{}

    throw new Error(e);
  }

  return r.text();
}

/*
  Streaming batch:
  Each completed sitemap is received immediately.
*/
async function apiBatchStream(urls,onItem){

  const r=await fetch("/api/batch",{
    method:"POST",
    headers:{
      "Content-Type":"application/json"
    },
    body:JSON.stringify({urls})
  });

  if(!r.ok){
    let e="HTTP "+r.status;

    try{
      const j=await r.json();
      e=j.error||e;
    }catch{}

    throw new Error(e);
  }

  if(!r.body)
    throw new Error("Streaming response not supported");

  const reader=r.body.getReader();
  const decoder=new TextDecoder();

  let buffer="";

  while(true){

    const {value,done}=await reader.read();

    if(value)
      buffer+=decoder.decode(value,{stream:!done});

    const lines=buffer.split("\\n");
    buffer=lines.pop()||"";

    for(const line of lines){

      if(!line.trim())
        continue;

      try{
        await onItem(JSON.parse(line));
      }catch(e){
        log("⚠ Invalid server result","err");
      }
    }

    if(done)
      break;
  }

  if(buffer.trim()){
    try{
      await onItem(JSON.parse(buffer));
    }catch{}
  }
}

async function discover(startUrls){

  const queue=[...startUrls];
  const final=[];
  const seen=new Set(startUrls);

  while(queue.length){

    if(stopped)
      break;

    const u=queue.shift();

    $("status").textContent=
      "Reading index/sitemap: "+u;

    log("→ "+u);

    try{

      const xml=await apiGet(u);

      if(isSitemapIndex(xml)){

        const children=
          extractLocs(xml).filter(c=>{
            if(!validChild(c)) return false;
            if(seen.has(c)) return false;
            seen.add(c);
            return true;
          });

        queue.push(...children);

        log(
          "→ Found "+
          children.length.toLocaleString()+
          " child sitemaps",
          "ok"
        );

      }else{

        final.push({
          url:u,
          xml
        });

      }

    }catch(e){

      $("failed").textContent=
        (+$("failed").textContent)+1;

      log(
        "✗ "+u+" — "+e.message,
        "err"
      );
    }
  }

  return final;
}

$("start").onclick=async()=>{

  stopped=false;

  $("start").disabled=true;
  $("stop").disabled=false;

  ["done","found","created","failed"]
    .forEach(id=>{
      $(id).textContent="0";
    });

  $("progress").style.width="0%";
  $("log").textContent="";

  /*
    Remove duplicate starting URLs.
  */
  const starts=[
    ...new Set(
      $("urls").value
        .split(/\\r?\\n/)
        .map(x=>x.trim())
        .filter(Boolean)
        .filter(validChild)
    )
  ];

  if(!starts.length){

    log(
      "Enter one or more valid HTTPS sitemap URLs.",
      "err"
    );

    $("start").disabled=false;
    $("stop").disabled=true;

    return;
  }

  // Collect all CSV files for the final ZIP
  const csvFiles=[];

  try{

    const direct=await discover(starts);

    /*
      Remove duplicate final sitemap URLs.
    */
    const queue=[
      ...new Set(
        direct.map(x=>x.url)
      )
    ];

    const total=queue.length;

    $("status").textContent=
      "Processing "+
      total.toLocaleString()+
      " sitemap(s)…";

    for(
      let i=0;
      i<queue.length&&!stopped;
      i+=${MAX_BATCH}
    ){

      const batch=queue.slice(
        i,
        i+${MAX_BATCH}
      );

      log(
        "⚡ Processing batch "+
        (Math.floor(i/${MAX_BATCH})+1)+
        " — "+
        batch.length+
        " sitemaps"
      );

      await apiBatchStream(
        batch,
        async item=>{

          if(stopped)
            return;

          const n=item.url;

          if(item.error){

            $("failed").textContent=
              (+$("failed").textContent)+1;

            log(
              "✗ "+n+" — "+item.error,
              "err"
            );

          }else{

            try{

              const urls=
                extractLocs(item.xml);

              const filename=
                urlName(
                  n,
                  i+$("done").textContent
                );

              // Collect instead of downloading immediately
              csvFiles.push({
                name:filename,
                content:makeCsvContent(urls)
              });

              $("found").textContent=
                (+$("found").textContent)+
                urls.length;

              $("created").textContent=
                (+$("created").textContent)+1;

              log(
                "✓ "+filename+
                " — "+
                urls.length.toLocaleString()+
                " URLs",
                "ok"
              );

            }catch(e){

              $("failed").textContent=
                (+$("failed").textContent)+1;

              log(
                "✗ Parse "+n+
                " — "+e.message,
                "err"
              );
            }
          }

          $("done").textContent=
            (+$("done").textContent)+1;

          $("progress").style.width=
            Math.round(
              (+$("done").textContent)/
              Math.max(total,1)*
              100
            )+"%";
        }
      );
    }

    // Create & download the single ZIP
    if(!stopped && csvFiles.length){
      $("status").textContent="Creating ZIP…";
      await downloadZip(csvFiles);
    }

  }catch(e){

    log(
      "✗ "+e.message,
      "err"
    );

  }finally{

    $("start").disabled=false;
    $("stop").disabled=true;

    $("status").textContent=
      stopped
        ? "Stopped."
        : "Finished.";

    log(
      stopped
        ? "■ Stopped."
        : "🎉 Finished.",
      stopped ? "" : "ok"
    );
  }
};

$("stop").onclick=()=>{
  stopped=true;

  $("status").textContent=
    "Stopping after the current batch…";
};

$("clear").onclick=()=>{
  location.reload();
};
</script>
</body>
</html>`;

function cors(){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type"
  };
}

function json(data,status=200){
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        ...cors(),
        "Content-Type":
          "application/json;charset=utf-8"
      }
    }
  );
}

function validTarget(value){
  try{
    if(typeof value !== "string" || value.length > MAX_URL_LENGTH) return false;
    const u=new URL(value);
    // Only allow https, block private/local targets to reduce SSRF risk
    if(u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    if(
      host === "localhost" ||
      host.endsWith(".localhost") ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\\.(1[6-9]|2\\d|3[0-1])\\./.test(host) ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) return false;
    return true;
  }catch{
    return false;
  }
}

/*
  Fetch sitemap with Worker cache.

  First request:
  Origin → Worker → Cache

  Later request:
  Worker Cache → fast response
*/
async function fetchSitemap(target){

  const cache=caches.default;

  const cacheKey=new Request(
    new URL(target).toString(),
    {
      method:"GET"
    }
  );

  /*
    Check Worker cache first.
  */
  const cached=await cache.match(cacheKey);

  if(cached){

    return new Response(
      cached.body,
      {
        status:cached.status,
        headers:new Headers(cached.headers)
      }
    );
  }

  /*
    Not cached.
    Fetch from origin.
  */
  const upstream=await fetch(
    target,
    {
      method:"GET",
      headers:{
        "User-Agent":"Mozilla/5.0 (compatible; SitemapCSVTool/3.1; +https://workers.dev)",
        "Accept":"application/xml, text/xml, */*"
      },
      redirect:"follow",
      cf: {
        // Avoid Cloudflare blocking some origins
        cacheTtl: 0,
        cacheEverything: false
      }
    }
  );

  if(!upstream.ok)
    return upstream;

  /*
    Read once so the same body can be:
    1. returned
    2. cached (only if it looks like XML)
  */
  const body=await upstream.arrayBuffer();
  const textPreview = new TextDecoder().decode(body.slice(0, 300)).trim();

  const headers=new Headers(
    upstream.headers
  );

  headers.delete("set-cookie");

  const looksLikeXml =
    textPreview.startsWith("<?xml") ||
    textPreview.startsWith("<urlset") ||
    textPreview.startsWith("<sitemapindex") ||
    textPreview.startsWith("<rss") ||
    textPreview.includes("<urlset") ||
    textPreview.includes("<sitemapindex");

  // Do not cache HTML downtime / error pages
  if(looksLikeXml){
    headers.set(
      "Cache-Control",
      "public, max-age="+CACHE_TTL
    );

    const responseForCache=new Response(
      body.slice(0),
      {
        status:upstream.status,
        headers
      }
    );

    try{
      await cache.put(
        cacheKey,
        responseForCache
      );
    }catch{}
  } else {
    headers.set("Cache-Control", "no-store");
  }

  return new Response(
    body,
    {
      status:upstream.status,
      headers
    }
  );
}

export default {

  async fetch(request){

    const url=new URL(request.url);

    if(request.method==="OPTIONS"){
      return new Response(
        null,
        {
          headers:cors()
        }
      );
    }

    /*
      Single sitemap endpoint.
    */
    if(url.pathname==="/api/sitemap"){

      const target=
        url.searchParams.get("url");

      if(!target)
        return json(
          {error:"Missing url parameter"},
          400
        );

      if(!validTarget(target))
        return json(
          {
            error:
              "Only public https:// sitemap URLs are allowed."
          },
          403
        );

      try{

        const upstream=
          await fetchSitemap(target);

        const headers=
          new Headers(upstream.headers);

        for(const [k,v] of Object.entries(cors()))
          headers.set(k,v);

        headers.set(
          "Cache-Control",
          "public, max-age="+CACHE_TTL
        );

        return new Response(
          upstream.body,
          {
            status:upstream.status,
            headers
          }
        );

      }catch(e){

        return json(
          {
            error:"Upstream fetch failed",
            detail:String(e)
          },
          502
        );
      }
    }

    /*
      Streaming batch endpoint.

      Maximum 20 sitemap fetches.

      Each sitemap is returned immediately
      when its request finishes.
    */
    if(url.pathname==="/api/batch"){

      if(request.method!=="POST")
        return json(
          {error:"POST required"},
          405
        );

      try{

        const body=await request.json();

        const input=
          Array.isArray(body.urls)
            ? body.urls
            : [];

        /*
          Remove duplicate URLs.
        */
        const urls=[
          ...new Set(input)
        ];

        if(!urls.length)
          return json(
            {error:"No sitemap URLs supplied"},
            400
          );

        if(urls.length>MAX_BATCH)
          return json(
            {
              error:
                "Too many URLs. Maximum per batch is "+
                MAX_BATCH
            },
            400
          );

        if(
          urls.some(
            u=>!validTarget(u)
          )
        )
          return json(
            {
              error:
                "All URLs must be public HTTPS sitemap URLs."
            },
            403
          );

        const encoder=new TextEncoder();

        let controllerRef;

        const stream=new ReadableStream({

          start(controller){

            controllerRef=controller;

            /*
              Start all requests at once.
            */
            Promise.all(

              urls.map(
                async u=>{

                  try{

                    const r=
                      await fetchSitemap(u);

                    if(!r.ok){

                      controller.enqueue(
                        encoder.encode(
                          JSON.stringify({
                            url:u,
                            error:
                              "HTTP "+r.status
                          })+"\n"
                        )
                      );

                      return;
                    }

                    const xml=
                      await r.text();

                    /*
                      Send this sitemap immediately.
                    */
                    controller.enqueue(
                      encoder.encode(
                        JSON.stringify({
                          url:u,
                          xml
                        })+"\n"
                      )
                    );

                  }catch(e){

                    controller.enqueue(
                      encoder.encode(
                        JSON.stringify({
                          url:u,
                          error:String(e)
                        })+"\n"
 
