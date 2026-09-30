"""Read recorded rows only; retain populations and missing stages explicitly."""
import gzip
import hashlib
import json
from pathlib import Path
root = Path(__file__).resolve().parents[1]
out = root / 'artifacts/event-grouped'
def stats(xs):
    xs = sorted(xs)
    return {'count': len(xs), 'mean': sum(xs)/len(xs) if xs else None,
            'median': xs[len(xs)//2] if xs else None, 'p95': xs[int(len(xs)*.95)] if xs else None}
def telemetry(rows):
    t = [r['ownershipTelemetry'] for r in rows]
    tasks = [task for r in rows for task in r['tasks'] if task['firstAssignedTick'] is not None]
    def stage_delta(a,b):
        result=[]
        for task in tasks:
            stages={**task.get('ownershipStages',{}),'createdAt':task['createdAt'],'firstAssignedTick':task['firstAssignedTick']}
            if stages.get(a) is not None and stages.get(b) is not None: result.append(stages[b]-stages[a])
        return stats(result)
    ticks=sum(r['ticksRun'] for r in rows)
    rounds=sum(x['auctionRounds'] for x in t);certs=sum(x['certifiedRounds'] for x in t)
    return {
        'population':'all first-assigned tasks, including incomplete runs; stages are fleet-minimum first observations',
        'certifiedTaskGenerationsPer100Ticks':100*certs/ticks,
        'eligibilityToFirstCertificate':stage_delta('firstAuctionEligibleTick','certificateTick'),
        'releaseToOwnership':stage_delta('createdAt','firstAssignedTick'),
        'releaseToEligibility':stage_delta('createdAt','firstAuctionEligibleTick'),
        'eligibilityToFirstBid':stage_delta('firstAuctionEligibleTick','firstBidTick'),
        'firstBidToQuorumBid':stage_delta('firstBidTick','quorumBidTick'),
        'quorumBidToProposal':stage_delta('quorumBidTick','proposalTick'),
        'proposalToFirstCertificate':stage_delta('proposalTick','certificateTick'),
        'firstCertificateToAssignment':stage_delta('certificateTick','firstAssignedTick'),
        'broadcastsPerPeerTick':sum(x['messages'] for x in t)/sum(x['peerTicks'] for x in t),
        'messageDefinition':'send calls including heartbeats and checkpoint gossip; each broadcast can deliver to N-1 peers; excludes motion traffic',
        'staleRejected':sum(x['staleRejected'] for x in t),
        'auctionedTaskGenerations':rounds,'certifiedTaskGenerations':certs,
        'uncertifiedObservedTaskGenerations':rounds-certs,
        'duplicateExecutableOwnerRobotTicks':sum(x['duplicateExecutableOwners'] for x in t),
        'peakConcurrentCandidateTasks':max(x['peakConcurrentTasks'] for x in t),
        'meanConcurrentCandidateTasks':sum(x['meanConcurrentTasks']*r['ticksRun'] for x,r in zip(t,rows))/ticks,
        'bundleSize':1,
        'limitations':'Observed rounds include renewals. Uncertified rounds are not necessarily quorum failures. First-stage timing does not isolate retries or per-round latency.'}
rows=json.loads((out/'phase1/D.json').read_text())
recorded=json.loads((root/'artifacts/sih-acceptance-v1/current/per-scenario.json').read_text())
old={r['scenarioId']:r for r in recorded['runs'] if r['arm']=='D'}
differences=[]
for row in rows:
    stripped={k:v for k,v in row.items() if k!='ownershipTelemetry'}
    stripped['tasks']=[{k:v for k,v in t.items() if k!='ownershipStages'} for t in row['tasks']]
    if stripped!=old[row['scenarioId']]:differences.append(row['scenarioId'])
(out/'phase1/epoch-reproduction.json').write_text(json.dumps({'compared':len(rows),'mismatches':differences},indent=2)+'\n')
pairs=json.loads((out/'phase2/development.json').read_text())
result={}
for n in [0,3,5,8]:
    for regime in ['all','low','recoverable','severe']:
        selected=[r for r in pairs if (not n or r['epoch']['fleetSize']==n) and (regime=='all' or r['epoch']['regime']==regime)]
        result[f'n{n}-{regime}']={arm:telemetry([r[arm] for r in selected]) for arm in ['epoch','event']}
(out/'phase2/throughput.json').write_text(json.dumps(result,indent=2)+'\n')
(out/'phase1/throughput.json').write_text(json.dumps({f'n{n}-{regime}':telemetry([r for r in rows if (not n or r['fleetSize']==n) and (regime=='all' or r['regime']==regime)]) for n in [0,3,5,8] for regime in ['all','low','recoverable','severe']},indent=2)+'\n')
for p in [out/'phase1/D.json',out/'phase2/development.json']:
    with (p.with_suffix('.json.gz')).open('wb') as stream:
        with gzip.GzipFile(fileobj=stream,mode='wb',mtime=0) as zipped:zipped.write(p.read_bytes())
(out/'provenance.json').write_text(json.dumps({
 'base':'6ad2458d6e32ee57e0267482fa6740124f7f04b2',
 'frozenSuiteSha256':{name:hashlib.sha256((root/'artifacts/sih-acceptance-v1'/name).read_bytes()).hexdigest() for name in ['scenarios.json','scenarios-development.json']},
 'sourceSha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in ['src/core/distributed/ownership.ts','src/core/distributed/runtime.ts','src/core/bench/sih/runner.ts','src/core/bench/stopwait.ts','src/core/pathfinding/astar.ts','src/core/distributed/agent.ts','src/core/distributed/fleet.ts','artifacts/bid-energy-v4/model.json']},
 'stop':'phase2 reliability regression; phases3/4 and G/H acceptance not run'},indent=2)+'\n')
print('Exact epoch mismatches:',len(differences))
