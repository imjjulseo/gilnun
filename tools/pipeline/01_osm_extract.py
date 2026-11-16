"""OSM(한국 전체 pbf) -> 서울권 보행로(선) / 수면·녹지(면) 추출. 출력: work/osm_lines.parquet, work/osm_areas.parquet"""
import sys, osmium, shapely, geopandas as gpd
src, out, idx = sys.argv[1], sys.argv[2], sys.argv[3]
S, W, N, E = 37.38, 126.72, 37.74, 127.22          # 서울 + 여유
wkb = osmium.geom.WKBFactory()
LKEEP = ('highway','name','foot','bridge','tunnel','layer','level','step_count','incline','surface','access','covered','indoor','sidewalk')
lines, areas = [], []
fp = (osmium.FileProcessor(src)
      .with_locations('sparse_mem_array')
      .with_areas(osmium.filter.KeyFilter('natural','waterway','landuse','leisure'))
      .with_filter(osmium.filter.EmptyTagFilter())
      .with_filter(osmium.filter.KeyFilter('highway','natural','waterway','landuse','leisure','water')))
def inbox(loc):
    return loc.valid() and S <= loc.lat <= N and W <= loc.lon <= E
n = 0
for o in fp:
    n += 1
    try:
        if o.is_way() and 'highway' in o.tags:
            nd = o.nodes
            if len(nd) < 2 or not (inbox(nd[0].location) or inbox(nd[-1].location)): continue
            t = o.tags
            lines.append((o.id, *[t.get(k) for k in LKEEP], wkb.create_linestring(o)))
        elif o.is_area():
            t = o.tags
            kind = None
            if t.get('natural') == 'water' or t.get('waterway') == 'riverbank' or t.get('landuse') == 'reservoir': kind = 'water'
            elif t.get('natural') in ('wood','scrub') or t.get('landuse') == 'forest': kind = 'forest'
            elif t.get('leisure') in ('park','garden','nature_reserve') or t.get('landuse') in ('grass','meadow','recreation_ground','cemetery'): kind = 'green'
            if not kind: continue
            ok = False
            for ring in o.outer_rings():
                for nd in ring:
                    if inbox(nd.location): ok = True; break
                if ok: break
            if not ok: continue
            areas.append((o.orig_id(), o.from_way(), kind, t.get('name'), t.get('water'), wkb.create_multipolygon(o)))
    except Exception as e:
        pass
print('scanned', n, 'lines', len(lines), 'areas', len(areas), flush=True)
import pandas as pd
dl = pd.DataFrame(lines, columns=['osm_id', *LKEEP, 'g'])
gl = gpd.GeoDataFrame(dl.drop(columns='g'), geometry=shapely.from_wkb(dl['g'].map(bytes.fromhex).values), crs=4326)
gl.to_parquet(f'{out}/osm_lines.parquet')
da = pd.DataFrame(areas, columns=['osm_id','from_way','kind','name','water','g'])
ga = gpd.GeoDataFrame(da.drop(columns='g'), geometry=shapely.from_wkb(da['g'].map(bytes.fromhex).values), crs=4326)
ga.to_parquet(f'{out}/osm_areas.parquet')
print('DONE', len(gl), len(ga), gl.highway.value_counts().head(12).to_dict(), ga.kind.value_counts().to_dict(), flush=True)
