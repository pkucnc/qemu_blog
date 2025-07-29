# A deep dive into QEMU: The execution loop and accelerators

We will go deeper into QEMU internals this time to give insights to hack
into core components. Let's look at the virtual CPU execution loop and its 
accelerators.

## The Big picture

In the very [first blog post](index.html) we explained how
accelerators were started, through
[`qemu_init_vcpu()`](https://github.com/qemu/qemu/tree/v4.2.0/cpus.c#L2134). 

In real code, each accelerator a `AccelOpsClass` structure which
contains function pointers to the accelerator specific code:
```c
struct AccelOpsClass {
    ...
    void (*ops_init)(AccelOpsClass *ops);

    bool (*cpus_are_resettable)(void);
    void (*cpu_reset_hold)(CPUState *cpu);

    void (*create_vcpu_thread)(CPUState *cpu); /* MANDATORY NON-NULL */
    void (*kick_vcpu_thread)(CPUState *cpu);
    bool (*cpu_thread_is_idle)(CPUState *cpu);
    ...
};
```

Then, in `qemu_init_vcpu()` we call the accelerator specific `qemu_tcg_init_vcpu()`. For example, if mttcg not enabled, the TCG accelerator registers its
`create_vcpu_thread` function pointer to [`rr_start_vcpu_thread()`]((https://github.com/qemu/qemu/tree/v10.0.2/accel/tcg/tcg-accel-ops-rr.c#L308)):

```c
void qemu_init_vcpu(CPUState *cpu)
{
    MachineState *ms = MACHINE(qdev_get_machine());
    ...
    /* accelerators all implement the AccelOpsClass */
    g_assert(cpus_accel != NULL && cpus_accel->create_vcpu_thread != NULL);
    cpus_accel->create_vcpu_thread(cpu);
    ...
}

void rr_start_vcpu_thread(CPUState *cpu)
{
    char thread_name[VCPU_THREAD_NAME_SIZE];
    ...
    if (!single_tcg_cpu_thread) {
        ...
        qemu_thread_create(cpu->thread, thread_name,
                           rr_cpu_thread_fn,
                           cpu, QEMU_THREAD_JOINABLE);
    } 
    ...
}

static void *rr_cpu_thread_fn(void *arg)
{
...
    while (1) {
        while (cpu && cpu_work_list_empty(cpu) && !cpu->exit_request) {
            ...
            qemu_clock_enable(QEMU_CLOCK_VIRTUAL, ...);
            ...
            if (cpu_can_run(cpu)) {
                r = tcg_cpu_exec(cpu);

                if (r == EXCP_DEBUG) {
                    cpu_handle_guest_debug(cpu);
                    break;
                }
            }
            cpu = CPU_NEXT(cpu);
        }
    }
}
```

This is a very simplified view but we can see the big picture. If the
vCPU is in a *runnable* state then we execute instructions via the
TCG. We will detail how it handles asynchronous events such as
interrupts and exceptions, but we can already see there is a special
handling for `EXCP_DEBUG` in the previous code excerpt.

There is nothing architecture dependent at this level, we are still in
a generic part of the QEMU engine. The debug exception special
treament here is usually triggered by underlying architecture
dependent events (ie. *breakpoints*) and require particular attention
from QEMU to be forwarded to other subsystems such as a GDB server
stub out of the context of the VM. We will also cover breakpoints
handling in a dedicated post.

## Entering the TCG execution loop

The interesting function to start with is
[`tcg_cpu_exec`](https://github.com/qemu/qemu/tree/v10.0.2/accel/tcg/tcg-accel-ops.c#L75)
and more specifically the
[`cpu_exec`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#1036)
one. We will cover in a future blog post the internals of
the TCG engine, but for now we only give an overview of the VM
execution. Simplified, it looks like:

```c
int cpu_exec(CPUState *cpu)
{
    SyncClocks sc = { 0 };
    ...
    cpu_exec_enter(cpu);
    ...
    ret = cpu_exec_setjmp(cpu, &sc);
    cpu_exec_exit(cpu);
    return ret;
}
```

QEMU makes use of `setjmp/longjmp` C library feature to implement
exception handling. This allows to get out of deep and complex TCG
translation functions whenever an event has been triggered, such as a
CPU interrupt or exception. The corresponding functions to exit the
CPU execution loop are
[`cpu_loop_exit_xxx`](https://github.com/qemu/qemu/blob/v4.2.0/accel/tcg/cpu-exec-common.c#L76):

```c
void cpu_loop_exit(CPUState *cpu)
{
    /* Undo the setting in cpu_tb_exec.  */
    cpu->neg.can_do_io = true;
    /* Undo any setting in generated code.  */
    qemu_plugin_disable_mem_helpers(cpu);
    siglongjmp(cpu->jmp_env, 1);
}
```

The vCPU thread code execution goes back to the point it called
`sigsetjmp`. Then QEMU tries to deal with the event as soon as
possible. But if there is no pending one, it executes the so-called
*Translated Blocks* (TB).


## A primer on Translated Blocks

The TCG engine is a JIT compiler, this means it dynamically translates
the target architecture instructions set to the host architecture
instruction set. For those not familiar with the concept please refer
to [this](https://en.wikipedia.org/wiki/Just-in-time_compilation) and
have a look at an introduction to the QEMU TCG engine
[here](https://wiki.qemu.org/Documentation/TCG). The translation is
done in two steps:
- from target ISA to intermediate representation (IR)
- from IR to host ISA

QEMU first tries to look for existing TBs, with
[`tb_lookup`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#L233). If
no one exists for the current location, it generates a new one with
[`tb_gen_code`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/translate-all.c#L290):

```c
static int cpu_exec_loop(CPUState *cpu, SyncClocks *sc)
{
    ...
    tb = tb_lookup(cpu, pc, cs_base, flags, cflags);
    if (tb == NULL) {
        ...
        tb = tb_gen_code(cpu, pc, cs_base, flags, cflags);
        ...
    }
    ...
}
```

When a TB is available, QEMU runs it with
[`cpu_loop_exec_tb`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#L897)
which in short calls
[`cpu_tb_exec`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#L441)
and then
[`tcg_qemu_tb_exec`](https://github.com/qemu/qemu/blob/v10.0.2/tcg/tci.c#L352). At
this point the target (VM) code has been translated to host code, QEMU
can run it directly on the host CPU. If we look at the definition of
this last function:

```c
uintptr_t QEMU_DISABLE_CFI tcg_qemu_tb_exec(CPUArchState *env, const void *v_tb_ptr)
{
    ...
    for (;;) {
        ...
        switch(opc) {
            case INDEX_op_call:
                {
                    ...
                    ffi_call(cif, func, stack, call_slots);
                    ...
                }
        }
    }
}
```

The translation buffer receiving generated opcodes is *casted* to a
function pointer and called with arguments.

In the TCG dedicated blog post, we will see the TCG strategy in detail
and present various *helpers* for system instructions, memory access
and things which can't be translated from an architecture to the
other.

## Back to events handling

When an hardware interrupt (IRQ) or exception is raised, QEMU *helps*
the vCPU redirects execution to the appropriate handler. These
mechanisms are very specific to the target architecture, consequently
hardly translatable. The answer comes from *helpers* which are tiny
wrappers written in C, built with QEMU for a target architecture and
natively callable on the host architecture directly from the
translated blocks. Again, we will cover them in details later.

For instance for the RISC-V target (VM), the *helpers* backend to inform
QEMU that an exception is being *raised* is located into
[tcg-cpu.c](https://github.com/qemu/qemu/blob/v10.0.2/target/target/riscv/tcg/tcg-cpu.c#L136), defined in a `TCGCPUOps` structure:

```c
static const TCGCPUOps riscv_tcg_ops = {
    .initialize = riscv_translate_init,
    .translate_code = riscv_translate_code, // remember this is, we will see it later
    .synchronize_from_tb = riscv_cpu_synchronize_from_tb,
    .restore_state_to_opc = riscv_restore_state_to_opc,

#ifndef CONFIG_USER_ONLY
    .tlb_fill = riscv_cpu_tlb_fill,
    .cpu_exec_interrupt = riscv_cpu_exec_interrupt,
    .cpu_exec_halt = riscv_cpu_has_work,
    .do_interrupt = riscv_cpu_do_interrupt,
...
#endif /* !CONFIG_USER_ONLY */
};

/* Exceptions processing helpers */
G_NORETURN void riscv_raise_exception(CPURISCVState *env, RISCVException exception, uintptr_t pc)
{
    CPUState *cs = env_cpu(env);

    trace_riscv_exception(exception,
                          riscv_cpu_get_trap_name(exception, false),
                          env->pc);

    cs->exception_index = exception;
    cpu_loop_exit_restore(cs, pc);
}
```

Notice the call to `cpu_loop_exit_restore` to get back to the main cpu
loop execution context and enter
[`cpu_handle_exception`](https://github.com/qemu/qemu/blob/v10.0.2/accel/tcg/cpu-exec.c#L951):

```c
static inline bool cpu_handle_exception(CPUState *cpu, int *ret)
{
    if (cpu->exception_index >= EXCP_INTERRUPT) {
        /* exit request from the cpu execution loop */
        *ret = cpu->exception_index;
        if (*ret == EXCP_DEBUG) {
            cpu_handle_debug_exception(cpu);
        }
        cpu->exception_index = -1;
        return true;
    } 
...
}
```

There is once again a specific handling on *debug exceptions*, but in
essence if there is a pending exception in `cpu->exception_index` it
will be managed by `cpu_handle_interrupt` which is architecture dependent (it will finally call `tcg_ops->cpu_exec_interrupt`).

The `exception_index` field can hold the real hardware exception but
is also used for meta information (QEMU debug event, halt instruction,
VMEXIT for nested virtualization on x86).

The underlying `x86_cpu_do_interrupt` is a place holder for various
cases (userland, system emulation or nested virtualization). In basic
system emulation mode it will call
[`do_interrupt_all`](https://github.com/qemu/qemu/blob/vv10.0.2/target/i386/seg_helper.c#L1166)
which implements low level x86 specific interrupt handling.
