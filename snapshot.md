---
layout: default
title: 07 VM Snapshotting
---

# A deep dive into QEMU: snapshot API

This blog post gives some insights on the QEMU snapshot API.

## Overview

The QEMU monitor exposes commands to create and restore snapshots of
your running VM: `savevm` and `loadvm`. QEMU offers advanced features
such as live migration that we won't deal with in this article.

However, the principle is based on the ability to save a complete and
restorable state of your virtual machine including its vCPU, RAM and
devices.

If we look at the service involved internally when invoking the
[`hmp_savevm`](https://github.com/qemu/qemu/blob/v10.0.2/migration/migration-hmp-cmds.c#L384)
command we will land in
[`save_snapshot`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L3219):

```c
void hmp_savevm(Monitor *mon, const QDict *qdict)
{
    Error *err = NULL;

    save_snapshot(qdict_get_try_str(qdict, "name"), true, NULL, false, NULL, &err);
    hmp_handle_error(mon, err);
}

bool save_snapshot(const char *name, bool overwrite, const char *vmstate,
                  bool has_devices, strList *devices, Error **errp)
{
...
    if (!bdrv_all_can_snapshot(has_devices, devices, errp)) {
        return false;
    }

...
    bs = bdrv_all_find_vmstate_bs(vmstate, has_devices, devices, errp);
    if (bs == NULL) {
        return false;
    }
    global_state_store();
    vm_stop(RUN_STATE_SAVE_VM);
...
    f = qemu_fopen_bdrv(bs, 1);
    if (!f) {
        error_setg(errp, "Could not open VM state file");
        goto the_end;
    }
    ret = qemu_savevm_state(f, errp);
    vm_state_size = qemu_file_transferred(f);
    ret2 = qemu_fclose(f);
    if (ret2 < 0) {
        goto the_end;
    }

...
    vm_resume(saved_state);
...
}
```

A lot of interesting things there. First the snapshot API is a file
based API. Second, your board' block devices (if any) must be
*snapshotable*. Third, there exists special [running states](runstate.md) related to snapshoting.

The block device *snapshot-ability* is specific and mainly related to
device read-only mode. However, the most important part of the
[`save_snapshot`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L3219):
function is tied to
[`qemu_savevm_state`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L1742)
which will proceed through every device
[`VMStateDescription`](https://github.com/qemu/qemu/tree/v10.0.2/include/migration/vmstate.h#L184)
thanks to
[`vmstate_save_state_v`](https://github.com/qemu/qemu/tree/v10.0.2/migration/vmstate.c#L398)


## Preparing your devices

To be snapshotable, a device must expose through a
[`VMStateDescription`](https://github.com/qemu/qemu/tree/v10.0.2/include/migration/vmstate.h#L184)
all of its internal state fields that must be saved and restored
during snapshot handling.

Obviously, it's a device based implementation. Usually, configured IO
registers are saved to preserve what drivers may have done during
initialisation.

Let's take an example based on [our timer device](timers.html) implementation:

```c
static const VMStateDescription vmstate_clabpu_timer = {
    .name = "clabpu-timer",
    .version_id = 1,
    .minimum_version_id = 1,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT32(counter, CLabPUTimerState),
        VMSTATE_UINT32(control, CLabPUTimerState),
        VMSTATE_UINT32(status, CLabPUTimerState),
        VMSTATE_UINT32(prescaler, CLabPUTimerState),
        VMSTATE_UINT32(frequency, CLabPUTimerState),
        VMSTATE_END_OF_LIST()
    }
};

static void clabpu_timer_class_init(ObjectClass *klass, void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    
    dc->realize = clabpu_timer_realize;
    dc->unrealize = clabpu_timer_unrealize;
    dc->legacy_reset = clabpu_timer_reset;
    dc->vmsd = &vmstate_clabpu_timer;
    device_class_set_props(dc, clabpu_timer_properties);
    dc->desc = "CLabPU Timer";
    set_bit(DEVICE_CATEGORY_MISC, dc->categories);
}
```

As you can see, the `VMStateDescription` exposes all the internal
registers of the timer so that they get automatically saved and
restored during snapshots.

The `vmsd` field of the `DeviceClass` is used during device
realization by QEMU
[`qdev`](https://github.com/qemu/qemu/tree/v10.0.2/hw/core/qdev.c#L517)
API with
[`vmstate_register`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L787).
If you look at QEMU git tree existing devices implementation, you will
find more complex definitions with
[`VMSTATE_PCI_DEVICE`](https://github.com/qemu/qemu/tree/v10.0.2/include/hw/pci/pci_device.h#L351)
or
[`VMSTATE_STRUCT`](https://github.com/qemu/qemu/tree/v10.0.2/include/migration/vmstate.h#L863)
declarations. Devices may also inherit higher-level/generic
`VMStateDescription` such as
[`serial-isa`](https://github.com/qemu/qemu/tree/v10.0.2/hw/char/serial-isa.c#106):

```c
const VMStateDescription vmstate_serial = {
    .name = "serial",
    .version_id = 3,
    .minimum_version_id = 2,
    .pre_save = serial_pre_save,
    .pre_load = serial_pre_load,
    .post_load = serial_post_load,
    .fields = (const VMStateField[]) {
        VMSTATE_UINT16_V(divider, SerialState, 2),
        VMSTATE_UINT8(rbr, SerialState),
        VMSTATE_UINT8(ier, SerialState),
        VMSTATE_UINT8(iir, SerialState),
        VMSTATE_UINT8(lcr, SerialState),
        VMSTATE_UINT8(mcr, SerialState),
        VMSTATE_UINT8(lsr, SerialState),
        VMSTATE_UINT8(msr, SerialState),
        VMSTATE_UINT8(scr, SerialState),
        VMSTATE_UINT8_V(fcr_vmstate, SerialState, 3),
        VMSTATE_END_OF_LIST()
    },
    .subsections = (const VMStateDescription * const []) {
        &vmstate_serial_thr_ipending,
        &vmstate_serial_tsr,
        &vmstate_serial_recv_fifo,
        &vmstate_serial_xmit_fifo,
        &vmstate_serial_fifo_timeout_timer,
        &vmstate_serial_timeout_ipending,
        &vmstate_serial_poll,
        NULL
    }
};

static const VMStateDescription vmstate_isa_serial = {
    .name = "serial",
    .version_id = 3,
    .minimum_version_id = 2,
    .fields = (const VMStateField[]) {
        VMSTATE_STRUCT(state, ISASerialState, 0, vmstate_serial, SerialState),
        VMSTATE_END_OF_LIST()
    }
};
```

## Lower level handlers

The internals of the VMState save/load API is backed by
[`SaveStateEntry`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L236)
fields. When you register a `vmsd` with
[`vmstate_register`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L787),
a new [`SaveStateEntry` is created](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L908):

```c
int vmstate_register_with_alias_id(VMStateIf *obj, uint32_t instance_id,
                                   const VMStateDescription *vmsd,
                                   void *opaque, int alias_id,
                                   int required_for_version,
                                   Error **errp)
{
    SaveStateEntry *se;
...
    se = g_new0(SaveStateEntry, 1);
    se->version_id = vmsd->version_id;
    se->section_id = savevm_state.global_section_id++;
    se->opaque = opaque;
    se->vmsd = vmsd;
...
    savevm_state_handler_insert(se);
    return 0;
}
```

The
[`qemu_savevm_state`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L1742)
function will iterate through the list of `SaveStateEntries` and call
their associated [`SaveVMHandlers *ops`](https://github.com/qemu/qemu/tree/v10.0.2/include/migration/register.h#L24)
respectively from
[`qemu_savevm_state_setup`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L1345)
and
[`qemu_savevm_state_iterate`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L1427).

```c
typedef struct SaveVMHandlers {
...
    void (*save_cleanup)(void *opaque);
    int (*save_live_complete_postcopy)(QEMUFile *f, void *opaque);
    int (*save_live_complete_precopy)(QEMUFile *f, void *opaque);
...
} SaveVMHandlers;
```

Depending on the fact that a device has a `vmsd` or not when
registering to the `vmstate` API or loading a snapshot file, QEMU
might call either the `SaveVMHandlers` from the `SaveStateEntry` or
lower level functions such as
[`vmstate_save_state_v`](https://github.com/qemu/qemu/tree/v10.0.2/migration/vmstate.c#L398)
or
[`vmstate_load_state`](https://github.com/qemu/qemu/tree/v10.0.2/migration/vmstate.c#L134)
as we can see for instance in
[`vmstate_load`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L966):

```c
static int vmstate_load(QEMUFile *f, SaveStateEntry *se)
{
    trace_vmstate_load(se->idstr, se->vmsd ? se->vmsd->name : "(old)");
    if (!se->vmsd) {         /* Old style */
        return se->ops->load_state(f, se->opaque, se->load_version_id);
    }
    return vmstate_load_state(f, se->vmsd, se->opaque, se->load_version_id);
}
```
## How the RAM is snapshoted?

Sometimes it's hard to find your way into the QEMU code, with all that
function pointers initialized you don't know where depending on some
other fields value :)

Using a debugger might speed-up the process! Let's use it to
understand how RAM is snapshoted.

First,
[`memory_region_init_ram`](https://github.com/qemu/qemu/tree/v10.0.2/system/memory.c#L3705)
registers something related to a vmstate with
[`vmstate_register_ram`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L3512):

```c
void vmstate_register_ram(MemoryRegion *mr, DeviceState *dev)
{
    qemu_ram_set_idstr(mr->ram_block,
                       memory_region_name(mr), dev);
    qemu_ram_set_migratable(mr->ram_block);
    ram_block_add_cpr_blocker(mr->ram_block, &error_fatal);
}
```

And ... *cool story bro' !*


We should better try to break into
[`qemu_savevm_state_setup`](https://github.com/qemu/qemu/tree/v10.0.2/migration/savevm.c#L1345):

```shell
Breakpoint 2, qemu_savevm_state_setup (f=0x555556bde230)

(gdb) print se->idstr 
$6 = "ram", '\000' <repeats 252 times>

(gdb) print se->vmsd
$7 = (const VMStateDescription *) 0x0

(gdb) print se->opaque
$8 = (void *) 0x5555565fabd8 <ram_state>

(gdb) print se->is_ram 
$9 = 1

(gdb) print se->ops 
$10 = (SaveVMHandlers *) 0x55555648eb20 <savevm_ram_handlers>
(gdb) print se->ops->save_cleanup
$11 = (void (*)(void *)) 0x55555580fc9e <ram_save_cleanup>
(gdb) print se->ops->has_postcopy 
$12 = (_Bool (*)(void *)) 0x5555558125a5 <ram_has_postcopy>
(gdb) print se->ops->save_setup 
$13 = (int (*)(QEMUFile *, void *)) 0x555555810b61 <ram_save_setup>
(gdb) print se->ops->save_state 
$14 = (SaveStateHandler *) 0x0
(gdb) print se->ops->load_state 
$15 = (LoadStateHandler *) 0x555555811f3f <ram_load>
```

The RAM `SaveStateEntry` does not have any `vmsd` and its `opaque`
field is initialized to a
[`RAMState`](https://github.com/qemu/qemu/tree/v10.0.2/migration/ram.c#L336)
object that will be used by the specific [`savevm_ram_handlers`](https://github.com/qemu/qemu/tree/v10.0.2/migration/ram.c#L4429).

Now we have function names to look at `migrate/ram.c`. We won't detail
the code from here. The interested reader might deep-dive into it and
discover the QEMU strategy looking for dirty memory pages to save to
optimize footprint.
