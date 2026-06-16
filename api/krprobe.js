// TEMP: probe K-Weather DOMESTIC (Korea) sensors. Remove after design.
//   GET /api/krprobe?sensor=kw-code-city2[&code=1168010100]
module.exports = async (req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  const base=process.env.KWEATHER_API_URL||"https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key=process.env.KWEATHER_API_KEY;
  const sensor=String(req.query.sensor||"kw-code-city2");
  const code=req.query.code!=null?String(req.query.code):"";
  if(!key)return res.status(503).json({error:"no key"});
  try{
    const url=code?`${base}/${sensor}/${encodeURIComponent(code)}?api_key=${encodeURIComponent(key)}`:`${base}/${sensor}?api_key=${encodeURIComponent(key)}`;
    const r=await fetch(url,{signal:AbortSignal.timeout(15000)});
    const t=await r.text(); let j; try{j=JSON.parse(t);}catch{}
    if(!j)return res.status(200).json({httpStatus:r.status,raw:t.slice(0,300)});
    const out={httpStatus:r.status,error:j.error,message:j.message};
    if(j.data&&typeof j.data==="object"){
      const keys=Object.keys(j.data); out.dataCount=keys.length; out.firstKeys=keys.slice(0,3);
      const first=j.data[keys[0]]; out.sample=first&&first.data?first.data:first;
    } else out.dataType=typeof j.data;
    return res.status(200).json(out);
  }catch(e){return res.status(502).json({error:String(e.message||e)});}
};
