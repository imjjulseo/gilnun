import sys, osmium
names = ['효사정','사육신공원','사육신묘','N서울타워','남산서울타워','63빌딩','63스퀘어','롯데월드타워','파크원','Parc1','국회의사당','노들섬','용양봉저정','노량진근린공원','국립서울현충원','보라매공원','한강대교','여의도한강공원']
fp = osmium.FileProcessor(sys.argv[1]).with_locations('sparse_mem_array').with_filter(osmium.filter.TagFilter(*[('name', n) for n in names]))
for o in fp:
    try:
        if o.is_node(): print('N', o.tags['name'], round(o.location.lon,5), round(o.location.lat,5), dict(o.tags).get('ele'), dict(o.tags).get('height'))
        elif o.is_way():
            l=[n.location for n in o.nodes if n.location.valid()]
            print('W', o.tags['name'], round(sum(a.lon for a in l)/len(l),5), round(sum(a.lat for a in l)/len(l),5), o.tags.get('height'), o.tags.get('building'), o.tags.get('highway'))
    except Exception as e: pass
