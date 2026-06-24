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

#endif
