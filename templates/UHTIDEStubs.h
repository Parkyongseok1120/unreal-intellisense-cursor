/**
 * IDE 전용 UHT 매크로 스텁 — UBT 빌드에 사용되지 않음.
 * clangd가 GENERATED_BODY / UPROPERTY 등을 인식하도록 함.
 * v4: UE 5.8 빌드 플래그 및 추가 리플렉션 매크로 지원.
 */
#pragma once

#ifndef UE58RIDER_UHT_IDE_STUBS
#define UE58RIDER_UHT_IDE_STUBS

#define UE58RIDER_STUB(...)

#ifndef WITH_EDITOR
#define WITH_EDITOR 1
#endif

#ifndef UE_BUILD_DEVELOPMENT
#define UE_BUILD_DEVELOPMENT 1
#endif

#ifndef GENERATED_BODY
#define GENERATED_BODY(...) UE58RIDER_STUB()
#endif

#ifndef GENERATED_BODY_LEGACY
#define GENERATED_BODY_LEGACY(...) UE58RIDER_STUB()
#endif

#ifndef GENERATED_UCLASS_BODY
#define GENERATED_UCLASS_BODY(...) UE58RIDER_STUB()
#endif

#ifndef GENERATED_USTRUCT_BODY
#define GENERATED_USTRUCT_BODY(...) UE58RIDER_STUB()
#endif

#ifndef GENERATED_UINTERFACE_BODY
#define GENERATED_UINTERFACE_BODY(...) UE58RIDER_STUB()
#endif

#ifndef GENERATED_IINTERFACE_BODY
#define GENERATED_IINTERFACE_BODY(...) UE58RIDER_STUB()
#endif

#ifndef UCLASS
#define UCLASS(...) UE58RIDER_STUB()
#endif

#ifndef USTRUCT
#define USTRUCT(...) UE58RIDER_STUB()
#endif

#ifndef UENUM
#define UENUM(...) UE58RIDER_STUB()
#endif

#ifndef UINTERFACE
#define UINTERFACE(...) UE58RIDER_STUB()
#endif

#ifndef UPROPERTY
#define UPROPERTY(...) UE58RIDER_STUB()
#endif

#ifndef UFUNCTION
#define UFUNCTION(...) UE58RIDER_STUB()
#endif

#ifndef UPARAM
#define UPARAM(...) UE58RIDER_STUB()
#endif

#ifndef UDELEGATE
#define UDELEGATE(...) UE58RIDER_STUB()
#endif

#ifndef UMETA
#define UMETA(...) UE58RIDER_STUB()
#endif

#ifndef DECLARE_DYNAMIC_MULTICAST_DELEGATE
#define DECLARE_DYNAMIC_MULTICAST_DELEGATE(...) UE58RIDER_STUB()
#endif

#ifndef DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam
#define DECLARE_DYNAMIC_MULTICAST_DELEGATE_OneParam(...) UE58RIDER_STUB()
#endif

#ifndef DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams
#define DECLARE_DYNAMIC_MULTICAST_DELEGATE_TwoParams(...) UE58RIDER_STUB()
#endif

#ifndef DECLARE_MULTICAST_DELEGATE
#define DECLARE_MULTICAST_DELEGATE(...) UE58RIDER_STUB()
#endif

#ifndef FORCEINLINE
#define FORCEINLINE inline
#endif

#ifndef UOBJECT_CPP
struct UObject;
struct UClass;
struct UStruct;
#endif

/*
 * UE 5.8's DECLARE_CLASS2 computes inherited cast flags through
 * Super::StaticAllClassCastFlags(). clangd parses project classes after a
 * textual MSVC PCH header, where some engine base UCLASS declarations do not
 * expose that member in its AST. Keep the real declaration surface but make
 * the IDE-only inherited-flags calculation local to the current class.
 *
 * This header is force-included only by clangd and is never passed to UBT.
 */
#ifdef DECLARE_CLASS2
#undef DECLARE_CLASS2
#define DECLARE_CLASS2( TClass, TSuperClass, TStaticFlags, TStaticCastFlags, TPackage, TPrivateAccessor ) \
private: \
	friend struct FUObjectCppClassStaticFunctions; \
	friend struct TUObjectCppClassStaticThunks<TClass>; \
public: \
	static constexpr EClassFlags StaticClassFlags = EClassFlags(TStaticFlags); \
	typedef TSuperClass Super; \
	typedef TClass ThisClass; \
	UE_REWRITE static UClass* StaticClass() \
	{ \
		return TPrivateAccessor(ETypeConstructPhase::Inner); \
	} \
	UE_REWRITE static const TCHAR* StaticPackage() \
	{ \
		return TPackage; \
	} \
	UE_REWRITE constexpr static EClassCastFlags StaticClassCastFlags() \
	{ \
		return TStaticCastFlags; \
	} \
	UE_REWRITE constexpr static EClassCastFlags StaticAllClassCastFlags() \
	{ \
		return StaticClassCastFlags(); \
	} \
	inline void* operator new(const size_t InSize, EInternal InInternalOnly, UObject* InOuter = GetTransientPackageAsObject(), FName InName = NAME_None, EObjectFlags InSetFlags = RF_NoFlags) \
	{ \
		return StaticAllocateObject(StaticClass(), InOuter, InName, InSetFlags); \
	} \
	inline void* operator new(const size_t InSize, EInternal* InMem) \
	{ \
		return (void*)InMem; \
	} \
	inline void operator delete(void* InMem) \
	{ \
		::operator delete(InMem); \
	}
#endif

/* The hot-reload helper is irrelevant to navigation and assumes a fully
 * modeled UObject inheritance chain. Avoid its false pointer conversion. */
#ifdef DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER
#undef DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER
#define DEFINE_VTABLE_PTR_HELPER_CTOR_CALLER(TClass) \
	static UObject* __VTableCtorCaller(FVTableHelper& Helper) \
	{ \
		return nullptr; \
	}
#endif

#endif
