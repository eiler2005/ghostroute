// Local metadata only: never performs network lookups or changes byte amounts.
export function localIpContext(db, value) {
  const ip=String(value||'').trim();
  const parts=ip.split('.');
  if(parts.length!==4 || parts.some(p=>!/^\d+$/.test(p)||Number(p)>255)) return null;
  const cached=db.prepare("select * from ip_enrichment_cache where ip=? and lookup_status='hit' limit 1").get(ip);
  if(cached)return cached;
  const integer=parts.reduce((n,p)=>n*256+Number(p),0);
  const prefix=db.prepare(`select prefix_cidr,asn,asn_org,provider,country,registry,source
    from ip_prefix_catalog where range_start_u32<=? and range_end_u32>=?
    order by (range_end_u32-range_start_u32) asc limit 1`).get(integer,integer);
  if(!prefix)return null;
  const provider=prefix.provider||prefix.asn_org||'';
  const normalized=provider.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||'network';
  return {ip,...prefix,provider,category_hint:`ip_asn.network_provider.${normalized}`,
    traffic_lane_hint:'shared_infra',dns_category_hint:'network_provider',decision_hint:'monitor',
    confidence:'estimated',lookup_status:'prefix_hit'};
}

export function withLocalIpContext(row, enrichment) {
  if(!enrichment)return row;
  return {...row,ip_provider:enrichment.provider||'',ip_asn:enrichment.asn||'',
    ip_asn_org:enrichment.asn_org||'',ip_category_hint:enrichment.category_hint||'',
    ip_traffic_lane_hint:enrichment.traffic_lane_hint||'',ip_dns_category_hint:enrichment.dns_category_hint||'',
    ip_decision_hint:enrichment.decision_hint||'',ip_enrichment_source:enrichment.source||'',
    ip_enrichment_confidence:enrichment.confidence||'',provider:row.provider||enrichment.provider||enrichment.asn_org||'',
    asn_org:row.asn_org||enrichment.asn_org||'',category:row.category||enrichment.category_hint||''};
}
