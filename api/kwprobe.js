module.exports = async (req,res)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  const base=process.env.KWEATHER_API_URL||"https://gateway.kweather.co.kr:8443/weather/w3/v2/kw-sensors";
  const key=process.env.KWEATHER_API_KEY;
  const code=String(req.query.code||"15103");
  try{
    const r=await fetch(`${base}/kw-world-r1/${code}?api_key=${encodeURIComponent(key)}`,{signal:AbortSignal.timeout(8000)});
    const j=await r.json();
    const d=j.data&&j.data.data;
    return res.status(200).json({ keys:d?Object.keys(d):null, sample:d });
  }catch(e){return res.status(502).json({error:String(e.message||e)});}
};
