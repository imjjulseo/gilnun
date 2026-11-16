"""OSM에서 높이 태그가 있는 고층 건물(>=80m) 추출 -> work/osm_tall.parquet (건물대장 높이 누락 보정용)"""
import sys, re, osmium, shapely, geopandas as gpd, pandas as pd
src, out = sys.argv[1], sys.argv[2]
S, W, N, E = 37.38, 126.72, 37.74, 127.22
wkb = osmium.geom.WKBFactory(); rows = []
def num(s):
    m = re.match(r'\s*([0-9.]+)', s or ''); return float(m.group(1)) if m else 0.0
fp = osmium.FileProcessor(src).with_locations('sparse_mem_array').with_areas(osmium.filter.KeyFilter('building', 'building:part', 'man_made')).with_filter(osmium.filter.KeyFilter('height', 'building:levels'))
for o in fp:
    try:
        if not o.is_area(): continue
        t = o.tags; h = num(t.get('height')); lv = num(t.get('building:levels'))
        if h < 80 and lv < 30: continue
        ok = False
        for ring in o.outer_rings():
            for nd in ring:
                l = nd.location; ok = l.valid() and S <= l.lat <= N and W <= l.lon <= E; break
            break
        if ok: rows.append((o.orig_id(), t.get('name'), h, lv, t.get('building') or t.get('man_made'), wkb.create_multipolygon(o)))
    except Exception: pass
d = pd.DataFrame(rows, columns=['osm_id', 'name', 'height', 'levels', 'kind', 'g'])
g = gpd.GeoDataFrame(d.drop(columns='g'), geometry=shapely.from_wkb(d['g'].map(bytes.fromhex).values), crs=4326).to_crs(5186)
g.to_parquet(out + '/osm_tall.parquet'); print(len(g)); print(g.sort_values('height', ascending=False)[['name', 'height', 'levels']].head(15).to_string())
