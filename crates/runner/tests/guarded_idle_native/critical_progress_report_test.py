#!/usr/bin/env python3
"""Real-file/CLI refusals for startup and actual Critical contention evidence."""

import copy
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

import critical_progress_report as progress
import critical_report
import critical_report_test
import foreground_report
import report
import startup_report


class CriticalProgressReportTests(unittest.TestCase):
    def setUp(self):
        critical_report_test.CriticalReportTests.setUp(self)
        self.critical_witnesses=self.witnesses
        self.witnesses,self.prepared=[],[]
        for event in self.events+self.critical_witnesses:
            event['case']=event['case'].replace('Critical-','CriticalProgress-')
        for case in sorted(progress.CASES):
            terminal=[e for e in self.events if e['case']==case]
            inherited=[e for e in self.critical_witnesses if e['case']==case]
            base=terminal[1]['monotonic_ns']
            def clock(seconds):return base+int(seconds*10**9)
            def observer(begin):return {'started_ns':begin+10_000_000,'completed_ns':begin+20_000_000,
                'available_bytes':32*1024**3,'age_ns':20,'read_duration_ns':10,'joined':True}
            runner=str(uuid.uuid4())
            def reporting(sequence,begin,allocated):return {'heartbeat':{'receipt':{
                'received_ns':begin+10_000_000,'acknowledgement_status':204,'state':{
                    'runnerId':runner,'snapshotGeneration':1,'snapshotSequence':sequence,'group':'native-foreground',
                    'mode':'running','allocatedVcpu':allocated[0],'allocatedMemoryMb':allocated[1]}},
                'send_joined':True,'completed_ns':begin+20_000_000},'observer':observer(begin+30_000_000)}
            def state(end):return {'state':'Critical','available_bytes':32*1024**3,'samples':[
                s for s in inherited[-1]['evidence']['samples'] if clock(3)<s['started_ns'] and s['finished_ns']<end]}
            def common(end):return {'pressure':state(end),'reads':copy.deepcopy(inherited[1]['evidence']['reads'])}
            startup={'accepted':1,'completed':1,'cancelled':0,'failed':0,'read_bytes':startup_report.BYTES,'last_error':None}
            values=[{'startup':startup,'startup_drained':True,'reads':copy.deepcopy(inherited[1]['evidence']['reads']),
                'state':'Unknown','startup_pressure_guarded':False,'pool_held_ns':clock(1.2),'status_held_ns':clock(1.3),'allocated':[6,12288,3]}]
            values.append(common(clock(4.5))|{'pool_held_ns':clock(1.2),'pending_observed_ns':clock(4.1),
                'waits_before':0,'waits_after':1,'actual_pressure_pool_pending':True,'observer':observer(clock(4.2)),
                'allocated':[6,12288,3]})
            values.append(common(clock(5.5))|{'status_held_ns':clock(1.3),'pool_released_ns':clock(4.6),
                'pending_observed_ns':clock(5.1),'waits_before':0,'waits_after':1,'actual_pressure_status_pending':True,
                'first_blank_cleanup_completed':True,'reporting':reporting(1,clock(5.2),(4,8192)),'allocated':[4,8192,2]})
            values.append(common(clock(21))|{'pool_held_ns':clock(20.1),'status_held_ns':clock(20.2),
                'pending_observed_ns':clock(20.3),'actual_foreground_pool_pending':True,
                'original_kernel_io_blocked':True,'observer':observer(clock(20.4)),'allocated':[2,4096,1]})
            values.append(common(clock(22))|{'status_held_ns':clock(20.2),'pool_released_ns':clock(21.1),
                'pending_observed_ns':clock(21.2),'actual_foreground_status_pending':True,
                'original_kernel_io_blocked':True,'reporting':reporting(2,clock(21.3),(2,4096)),'allocated':[2,4096,1]})
            fresh={key:str(uuid.uuid4()) for key in ('sandbox_id','run_id','operation_id','backing_generation')}
            fresh['backing_exit_confirmed']=True
            values.append(common(clock(24))|{'foreground':fresh,'foreground_joined':True,'guest_rpc_completed':True,
                'phase_settled':True,'original_kernel_io_blocked':True,'release_byte_withheld':True,
                'original_full_lease':[2,4096,1],'reporting':reporting(3,clock(23.5),(2,4096)),'allocated':[2,4096,1]})
            values.append({'startup':startup,'reads':copy.deepcopy(inherited[-1]['evidence']['reads']),
                **{key:True for key in ('startup_drained','runtime_drained','foreground_joined','heartbeat_joined',
                    'provider_joined','peer_joined','pressure_stopped','snapshot_reverified')},'allocated':[0,0,0]})
            for phase,value,second in zip(progress.PHASES,values,(3,4.5,5.5,21,22,24,36)):
                self.witnesses.append({'version':1,'case':case,'phase':phase,'monotonic_ns':clock(second),'unix_ns':clock(second)+1000,
                    'sandbox_id':terminal[1]['sandbox_id'],'backing_generation':terminal[1]['backing_generation'],'evidence':value})
            self.prepared.append({'version':1,'case':case,'phase':'foreground_prepared','monotonic_ns':clock(23),'unix_ns':clock(23)+1000,
                'sandbox_id':terminal[1]['sandbox_id'],'backing_generation':terminal[1]['backing_generation'],
                'evidence':{'kind':'Fresh',**{k:fresh[k] for k in ('sandbox_id','run_id','operation_id')},
                    'guest_rpc_completed':True,'phase_settled':True,'original_owner_preserved':True,'allocated':[2,4096,1]}})

    def event(self,phase):return next(e for e in self.witnesses if e['case']=='CriticalProgress-fresh' and e['phase']==phase)

    def write(self):
        (self.root/'report.json').write_text(json.dumps(self.collector))
        (self.root/'samples.jsonl').write_text('\n'.join(json.dumps(s) for s in self.samples))
        (self.root/'stdout.log').write_text('\n'.join(prefix+json.dumps(e) for prefix,items in (
            (report.PREFIX,self.events),(critical_report.PREFIX,self.critical_witnesses),
            (foreground_report.PREFIX,self.prepared),(progress.PREFIX,self.witnesses)) for e in items))

    def validate(self):self.write();return progress.validate(self.root)

    def refused(self,changes):
        saved=copy.deepcopy(self.witnesses)
        for change in changes:
            self.witnesses=copy.deepcopy(saved);change()
            with self.assertRaises(ValueError):self.validate()

    def test_complete_two_modes_keep_production_limits(self):
        value=self.validate()
        self.assertEqual(set(value['cases']),progress.CASES)
        self.assertTrue(value['native_critical_progress_complete'])
        for key in ('startup_pressure_guarded','production_protection_proven','memory_envelope_calibrated'):
            self.assertFalse(value[key])

    def test_real_cli_requires_complete_files(self):
        self.write();command=[sys.executable,str(pathlib.Path(__file__).with_name('critical_progress_report.py')),str(self.root)]
        self.assertTrue(json.loads(subprocess.check_output(command))['native_critical_progress_complete'])
        self.witnesses.pop();self.write()
        self.assertNotEqual(subprocess.run(command,capture_output=True).returncode,0)

    def test_missing_duplicate_and_wrong_original_are_refused(self):
        self.refused((lambda:self.witnesses.pop(),lambda:self.witnesses.append(copy.deepcopy(self.witnesses[-1])),
            lambda:self.witnesses[0].update(version=True),lambda:self.witnesses[1].update(backing_generation=str(uuid.uuid4()))))

    def test_startup_must_completely_read_original_under_unknown(self):
        self.refused((lambda:self.event('startup_unknown')['evidence']['startup'].update(read_bytes=1),
            lambda:self.event('startup_unknown')['evidence'].update(state='Critical'),
            lambda:self.event('startup_unknown')['evidence'].update(startup_pressure_guarded=True)))

    def test_every_phase_requires_suppressed_runtime(self):
        self.refused(tuple(lambda phase=phase:self.event(phase)['evidence']['reads'].update(accepted=1)
            for phase in progress.PHASES))

    def test_pressure_pool_must_be_actual_pending(self):
        self.refused((lambda:self.event('pressure_pool_wait_progress')['evidence'].update(waits_after=0),
            lambda:self.event('pressure_pool_wait_progress')['evidence'].update(actual_pressure_pool_pending=False),
            lambda:self.event('pressure_pool_wait_progress')['evidence'].update(pending_observed_ns=1)))

    def test_pressure_status_wait_requires_first_completed_cleanup(self):
        self.refused((lambda:self.event('pressure_status_wait_progress')['evidence'].update(waits_after=2),
            lambda:self.event('pressure_status_wait_progress')['evidence'].update(allocated=[6,12288,3]),
            lambda:self.event('pressure_status_wait_progress')['evidence'].update(first_blank_cleanup_completed=False)))

    def test_critical_samples_cannot_be_fabricated_or_renewed(self):
        self.refused((lambda:self.event('foreground_io_wait_progress')['evidence']['pressure'].update(samples=[]),
            lambda:self.event('pressure_pool_wait_progress')['evidence']['pressure'].update(state='Ready'),
            lambda:self.event('foreground_status_wait_progress')['evidence']['pressure']['samples'][-1].update(age_ns=10**10)))

    def test_foreground_needs_actual_pool_and_status_pending(self):
        self.refused((lambda:self.event('foreground_pool_wait_progress')['evidence'].update(actual_foreground_pool_pending=False),
            lambda:self.event('foreground_status_wait_progress')['evidence'].update(actual_foreground_status_pending=False)))

    def test_foreground_and_heartbeat_must_remain_inside_original_io(self):
        self.refused((lambda:self.event('foreground_io_wait_progress').update(monotonic_ns=
            next(e for e in self.events if e['case']=='CriticalProgress-fresh' and e['phase']=='required_tail_completed')['monotonic_ns']),
            lambda:self.event('foreground_status_wait_progress')['evidence'].update(original_kernel_io_blocked=False),
            lambda:self.event('foreground_io_wait_progress')['evidence'].update(release_byte_withheld=False)))

    def test_original_full_lease_and_distinct_new_physical_exit_required(self):
        self.refused((lambda:self.event('foreground_io_wait_progress')['evidence'].update(original_full_lease=[0,0,0]),
            lambda:self.event('foreground_io_wait_progress')['evidence']['foreground'].update(backing_exit_confirmed=False),
            lambda:self.event('foreground_io_wait_progress')['evidence']['foreground'].update(backing_generation=
                self.event('foreground_io_wait_progress')['backing_generation'])))

    def test_real_reported_rpc_and_original_authority_phase_must_match(self):
        self.prepared[0]['evidence']['operation_id']=str(uuid.uuid4())
        with self.assertRaises(ValueError):self.validate()

    def test_independent_acknowledgement_observation_and_generation_required(self):
        self.refused((lambda:self.event('pressure_status_wait_progress')['evidence']['reporting']['heartbeat']['receipt'].update(acknowledgement_status=500),
            lambda:self.event('foreground_status_wait_progress')['evidence']['reporting']['observer'].update(joined=False),
            lambda:self.event('foreground_io_wait_progress')['evidence']['reporting']['heartbeat']['receipt']['state'].update(runnerId=str(uuid.uuid4()))))

    def test_every_accepted_producer_must_join(self):
        self.refused(tuple(lambda key=key:self.event('producers_joined')['evidence'].update({key:False}) for key in (
            'startup_drained','runtime_drained','foreground_joined','heartbeat_joined','provider_joined','peer_joined','pressure_stopped','snapshot_reverified')))

    def test_inherited_fresh_post_wave_and_complete_durable_proof_required(self):
        self.critical_witnesses[3]['evidence']['completion_observed_ns']=1
        with self.assertRaises(ValueError):self.validate()


if __name__=='__main__':unittest.main()
