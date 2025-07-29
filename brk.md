# A deep dive into QEMU: Breakpoints handling

In this post we will learn how breakpoints are checked and raised
during translation, and processed inside the vCPU main execution
loop. We assume an i386 target as most readers are familiar with this
architecture.

## How breakpoints are handled

Important Note: In QEMU v10.0.2, breakpoint handling has been significantly redesigned compared to earlier versions. The breakpoint_check callback that was previously part of TranslatorOps was removed in July 2021 (QEMU 6.1 development cycle), see: https://lists.nongnu.org/archive/html/qemu-devel/2021-07/msg05731.html

Newer versions of QEMU decouple breakpoints handling from TCG translation. All breakpoint checks are now performed in the [`cpu_exec_loop`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#L946), before TCG translation starts. When there is a breakpoint hit, the `cpu->exception_index = EXCP_DEBUG` is set and `break` is called to exit the loop. The `EXCP_DEBUG` exception is then handled in the main execution loop by `cpu_handle_exception`.

```c
static int __attribute__((noinline))
cpu_exec_loop(CPUState *cpu, SyncClocks *sc)
{
    ...
    while (!cpu_handle_exception(cpu, &ret)) {
        ...
        while (!cpu_handle_interrupt(cpu, &last_tb)) {
            ...
            if (check_for_breakpoints(cpu, pc, &cflags)) {
                break;
            }
            tb = tb_lookup(cpu, pc, cs_base, flags, cflags);
            ...
        }
        ...
    }
}

static inline bool check_for_breakpoints(CPUState *cpu, vaddr pc,
                                         uint32_t *cflags)
{
    return unlikely(!QTAILQ_EMPTY(&cpu->breakpoints)) &&
        check_for_breakpoints_slow(cpu, pc, cflags); // only enter the slow path if there are breakpoints
}

static bool check_for_breakpoints_slow(CPUState *cpu, vaddr pc,
                                       uint32_t *cflags)
{
    CPUBreakpoint *bp;
    ...

    QTAILQ_FOREACH(bp, &cpu->breakpoints, entry) {
        if (pc == bp->pc) {
            bool match_bp = false;

            if (bp->flags & BP_GDB) {
                match_bp = true;
            } else if (bp->flags & BP_CPU) {
                const TCGCPUOps *tcg_ops = cpu->cc->tcg_ops;
                assert(tcg_ops->debug_check_breakpoint);
                match_bp = tcg_ops->debug_check_breakpoint(cpu);
            }
            if (match_bp) {
                cpu->exception_index = EXCP_DEBUG;
                return true;
            }
        } 
        ...
    }
    ...
}

```

## QEMU breakpoints

There exists different [breakpoint
types](https://github.com/qemu/qemu/blob/v10.0.2/include/hw/core/cpu.h#L1079)
inside QEMU. Some are installed from inside the VM, others might be
installed through the GDB server stub when debugging a VM. In such a
situation they are of type `BP_GDB` and are never ignored even if
`EFLAGS.RF` is set. 

So what really happens when a breakpoint is hit? The
[`breakpoint_handler`](https://github.com/qemu/qemu/blob/v10.0.2/target/i386/tcg/system/bpt_helper.c#L209) is the debug_check_breakpoint for the i386 target:

```c
void breakpoint_handler(CPUState *cs)
{
    X86CPU *cpu = X86_CPU(cs);
    CPUX86State *env = &cpu->env;

    if (cs->watchpoint_hit) {
        if (cs->watchpoint_hit->flags & BP_CPU) {
            cs->watchpoint_hit = NULL;
            if (check_hw_breakpoints(env, false)) {
                raise_exception(env, EXCP01_DB);
            } else {
                cpu_loop_exit_noexc(cs);
            }
        }
    } else {
        if (cpu_breakpoint_test(cs, env->eip, BP_CPU)) {
            check_hw_breakpoints(env, true);
            raise_exception(env, EXCP01_DB);
        }
    }
}
```

This function is quite interesting. It decides if QEMU should inject
or not, the debug exception inside the target. Let's say for instance,
that the breakpoint is due to GDB from a host client. In
this case, no `raise_exception` happens and we return from
`breakpoint_handler`. But return where? Out of
`cpu_handle_debug_exception`, then `cpu_handle_exception`, then
[`cpu_exec`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#1036)
and even out of
[`tcg_cpu_exec`](https://github.com/qemu/qemu/tree/v10.0.2/accel/tcg/tcg-accel-ops.c#L75)
to land back in
[`rr_cpu_thread_fn`](https://github.com/qemu/qemu/tree/v10.0.2/cpus.c#L1580):

```c
static void *rr_cpu_thread_fn(void *arg)
{

...
    r = tcg_cpu_exec(cpu);

    if (r == EXCP_DEBUG) {
        cpu_handle_guest_debug(cpu);
        break;
    }
...
```

Where QEMU deals with `EXCP_DEBUG` and calls
[`cpu_handle_guest_debug`](https://github.com/qemu/qemu/tree/v10.0.2/system/cpus.c#L334) which has nothing to do anymore with low level target breakpoint handling:

```c
void cpu_handle_guest_debug(CPUState *cpu)
{
    ...
    gdb_set_stop_cpu(cpu);
    qemu_system_debug_request();
    cpu->stopped = true;
    ...
}
```

At this stage, this is pure QEMU internals about event requests and VM
state changes. We will have a blog post on this too. What you should
keep in mind is that the QEMU
[`main_loop_should_exit`](https://github.com/qemu/qemu/tree/v10.0.2/system/runstate.c#L771)
function will check the debug request and all associated handlers will
be notified.

## QEMU watchpoints

The logic is pretty much the same for *execution watchpoints*. However
watchpoints can also be installed for read/write memory operations. To
that extent, the QEMU memory access path should check for possible
watchpoint hit.

This is happening in QEMU [virtual TLB](https://github.com/qemu/qemu/tree/v10.0.2/accel/tcg/cputlb.c)
management code for the TCG execution mode. The implied function is
[`cpu_check_watchpoint`](https://github.com/qemu/qemu/tree/v10.0.2/accel/tcg/watchpoint.c#L68)

As you are getting used to, we will cover this in a QEMU low level
memory management dedicated blog post, in the TCG section.
