"""도보 네트워크 -> 동선용 그래프(graph.bin). 지역 경계 + 300m 안의 보행 링크로 만든다.
형식 (리틀 엔디언):
  Uint32[4]  매직 0x4C475447('GTGL'), 노드 수 N, 간선 수 E, 좌표 수 C
  Int32[2N]  노드 경도, 위도 (×1e6)
  Uint32[2E] 간선 양끝 노드 번호
  Float32[E] 간선 길이(m)
  Uint8[4E]  간선 뷰 값 k(하늘), w(물), g(녹지) 0~100, c(조용함 배수×100, 최대 115)
  Uint32[E+1] 간선 모양 좌표 시작 위치(좌표 단위)
  Int32[2C]  간선 모양 좌표 경도, 위도 (×1e6). 첫 좌표가 from 노드 쪽.
간선은 양방향이다. 지하철 통로는 뺀다. 뷰 계산이 없는 링크는 k=w=g=0, c=100."""
import os, json, struct, numpy as np, pandas as pd, geopandas as gpd, shapely
from pyproj import Transformer
U = os.environ.get('VIEWAPP', '/mnt/user-data/uploads/viewapp')
OUT = os.environ.get('APPDATA', os.path.join(os.path.dirname(__file__), '..', 'public', 'data'))
man = json.load(open(f'{OUT}/manifest.json'))
L = gpd.read_parquet(f'{U}/work/walknet_links.parquet')
D = pd.read_parquet(f'{U}/work/pilot/scored.parquet', columns=['link', 's_sky', 's_depth', 's_pano', 's_water', 's_nature', 'f_calm'])
D['open'] = 0.60 * D.s_sky + 0.25 * D.s_depth + 0.15 * D.s_pano
V = D.groupby('link').agg(k=('open', 'mean'), w=('s_water', 'mean'), g=('s_nature', 'mean'), c=('f_calm', 'mean'))
to_xy = Transformer.from_crs(4326, 5186, always_xy=True); to_ll = Transformer.from_crs(5186, 4326, always_xy=True)
for reg in man['regions']:
    b = reg['bbox']; (x0, y0), (x1, y1) = [to_xy.transform(b[0], b[1]), to_xy.transform(b[2], b[3])]
    G = L[L.intersects(shapely.box(x0 - 300, y0 - 300, x1 + 300, y1 + 300)) & ~L.subway].copy()
    G = G.explode(index_parts=False)
    G['geometry'] = G.geometry.simplify(0.8)
    key = lambda x, y: (round(x * 2), round(y * 2))                 # 0.5m 단위로 끝점을 맞춘다
    nid: dict = {}; nxy = []
    def node(x, y):
        k = key(x, y)
        if k not in nid: nid[k] = len(nxy); nxy.append((x, y))
        return nid[k]
    ea, eb, el, ev, starts, coords = [], [], [], [], [0], []
    for r in G.itertuples():
        cs = np.asarray(r.geometry.coords)[:, :2]
        if len(cs) < 2 or r.geometry.length < 0.3: continue
        a, bb = node(*cs[0]), node(*cs[-1])
        if a == bb: continue
        v = V.loc[r.link] if r.link in V.index else None
        ea.append(a); eb.append(bb); el.append(r.geometry.length)
        ev.append((0, 0, 0, 100) if v is None else tuple(int(round(min(max(t, 0), 1) * 100)) for t in (v.k, v.w, v.g)) + (int(round(min(v.c, 1.15) * 100)),))
        lon, lat = to_ll.transform(cs[:, 0], cs[:, 1]); coords += [(int(round(p * 1e6)), int(round(q * 1e6))) for p, q in zip(lon, lat)]
        starts.append(len(coords))
    # 가장 큰 연결 덩어리만 남긴다
    import scipy.sparse as sp, scipy.sparse.csgraph as cg
    N = len(nxy); A = sp.coo_matrix((np.ones(len(ea)), (ea, eb)), shape=(N, N))
    nc, lab = cg.connected_components(A, directed=False); big = np.bincount(lab).argmax()
    keepN = lab == big; remap = -np.ones(N, int); remap[keepN] = np.arange(keepN.sum())
    keepE = [i for i in range(len(ea)) if keepN[ea[i]]]
    nlon, nlat = to_ll.transform(*np.asarray(nxy)[keepN].T)
    buf = bytearray()
    C2 = []; st2 = [0]
    for i in keepE: C2 += coords[starts[i]:starts[i + 1]]; st2.append(len(C2))
    E = len(keepE); Nn = int(keepN.sum())
    buf += struct.pack('<4I', 0x4C475447, Nn, E, len(C2))
    buf += np.column_stack([np.round(nlon * 1e6), np.round(nlat * 1e6)]).astype('<i4').tobytes()
    buf += np.column_stack([remap[np.asarray(ea)[keepE]], remap[np.asarray(eb)[keepE]]]).astype('<u4').tobytes()
    buf += np.asarray(el, '<f4')[keepE].tobytes()
    buf += np.asarray(ev, 'u1')[keepE].tobytes()
    buf += np.asarray(st2, '<u4').tobytes()
    buf += np.asarray(C2, '<i4').tobytes()
    open(f"{OUT}/{reg['id']}/graph.bin", 'wb').write(buf)
    reg['graph'] = f"{reg['id']}/graph.bin"
    print(reg['id'], 'nodes', Nn, 'edges', E, 'coords', len(C2), 'components', nc, 'dropped edges', len(ea) - E, len(buf) // 1024, 'KB')
json.dump(man, open(f'{OUT}/manifest.json', 'w'), ensure_ascii=False, indent=1)
