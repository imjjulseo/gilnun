"""서울시 도보 네트워크 CSV -> 보행 가능 링크 parquet (work/walknet_links.parquet, EPSG:5186)"""
import os, glob, pandas as pd, geopandas as gpd, shapely
H = os.environ['HOME'] + '/mnt/viewapp'; f = glob.glob(H + '/data/walknet/*.csv')[0]
d = pd.read_csv(f, encoding='cp949', dtype=str); d = d[d['노드링크 유형'] == 'LINK']
d = d[d['링크 유형 코드'].str[0] == '1']                       # 보행자 통행 가능
g = gpd.GeoDataFrame(dict(link=d['링크 ID'].values, code=d['링크 유형 코드'].values, gu=d['시군구명'].values, dong=d['읍면동명'].values,
     elevated=(d['고가도로'] == '1').values, subway=(d['지하철네트워크'] == '1').values, bridge=(d['교량'] == '1').values, tunnel=(d['터널'] == '1').values,
     overpass=(d['육교'] == '1').values, crosswalk=(d['횡단보도'] == '1').values, park=(d['공원,녹지'] == '1').values, indoor=(d['건물내'] == '1').values),
     geometry=shapely.from_wkt(d['링크 WKT'].values), crs=4326).to_crs(5186)
g.to_parquet(H + '/work/walknet_links.parquet'); print(len(g), 'km %.0f' % (g.length.sum() / 1000))
