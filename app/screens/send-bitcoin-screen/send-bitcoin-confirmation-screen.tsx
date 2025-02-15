import { gql } from "@apollo/client"
import DestinationIcon from "@app/assets/icons/destination.svg"
import NoteIcon from "@app/assets/icons/note.svg"
import { PaymentDestinationDisplay } from "@app/components/payment-destination-display"
import { Screen } from "@app/components/screen"
import {
  useSendBitcoinConfirmationScreenQuery,
  WalletCurrency,
} from "@app/graphql/generated"
import { useIsAuthed } from "@app/graphql/is-authed-context"
import { useDisplayCurrency } from "@app/hooks/use-display-currency"
import { useI18nContext } from "@app/i18n/i18n-react"
import { RootStackParamList } from "@app/navigation/stack-param-lists"
import {
  addMoneyAmounts,
  DisplayCurrency,
  lessThanOrEqualTo,
  moneyAmountIsCurrencyType,
  toBtcMoneyAmount,
  toUsdMoneyAmount,
  ZeroBtcMoneyAmount,
  ZeroUsdMoneyAmount,
} from "@app/types/amounts"
import { logPaymentAttempt, logPaymentResult } from "@app/utils/analytics"
import crashlytics from "@react-native-firebase/crashlytics"
import { CommonActions, RouteProp, useNavigation } from "@react-navigation/native"
import { StackNavigationProp } from "@react-navigation/stack"
import { makeStyles, Text, useTheme } from "@rneui/themed"
import React, { useEffect, useMemo, useState } from "react"
import { ActivityIndicator, View } from "react-native"
import ReactNativeHapticFeedback from "react-native-haptic-feedback"
import { testProps } from "../../utils/testProps"
import useFee, { FeeType } from "./use-fee"
import { useSendPayment } from "./use-send-payment"
import { AmountInput } from "@app/components/amount-input"
import { GaloyPrimaryButton } from "@app/components/atomic/galoy-primary-button"
import { getBtcWallet, getUsdWallet } from "@app/graphql/wallets-utils"

// Breez SDK
import useBreezBalance from "@app/hooks/useBreezBalance"
import { fetchReverseSwapFeesBreezSDK } from "@app/utils/breez-sdk"

gql`
  query sendBitcoinConfirmationScreen {
    me {
      id
      defaultAccount {
        id
        wallets {
          id
          balance
          walletCurrency
        }
      }
    }
  }
`

type Props = { route: RouteProp<RootStackParamList, "sendBitcoinConfirmation"> }

const SendBitcoinConfirmationScreen: React.FC<Props> = ({ route }) => {
  const {
    theme: { colors },
  } = useTheme()
  const styles = useStyles()

  const navigation =
    useNavigation<StackNavigationProp<RootStackParamList, "sendBitcoinConfirmation">>()

  const { paymentDetail } = route.params

  const {
    destination,
    paymentType,
    sendingWalletDescriptor,
    sendPaymentMutation,
    getFee,
    settlementAmount,
    memo: note,
    unitOfAccountAmount,
    convertMoneyAmount,
    isSendingMax,
  } = paymentDetail

  const { formatDisplayAndWalletAmount } = useDisplayCurrency()

  const { data } = useSendBitcoinConfirmationScreenQuery({ skip: !useIsAuthed() })

  // import and use breez balance
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [breezBalance, setBreezBalance] = useBreezBalance()

  const btcWallet = getBtcWallet(data?.me?.defaultAccount?.wallets)
  const usdWallet = getUsdWallet(data?.me?.defaultAccount?.wallets)

  const btcBalanceMoneyAmount = toBtcMoneyAmount(breezBalance || btcWallet?.balance)

  const usdBalanceMoneyAmount = toUsdMoneyAmount(usdWallet?.balance)

  const btcWalletText = formatDisplayAndWalletAmount({
    displayAmount: convertMoneyAmount(btcBalanceMoneyAmount, DisplayCurrency),
    walletAmount: btcBalanceMoneyAmount,
  })

  const usdWalletText = formatDisplayAndWalletAmount({
    displayAmount: convertMoneyAmount(usdBalanceMoneyAmount, DisplayCurrency),
    walletAmount: usdBalanceMoneyAmount,
  })

  const [paymentError, setPaymentError] = useState<string | undefined>(undefined)
  const { LL } = useI18nContext()

  const [fee, setFee] = useState<FeeType>({ status: "loading" })
  const getLightningFee = useFee(getFee ? getFee : null)
  // Moved this logic outside of the if-else statement to make sure hooks are not called conditionally
  useEffect(() => {
    if (
      paymentDetail.paymentType === "lightning" ||
      paymentDetail.paymentType === "lnurl"
    ) {
      setFee(getLightningFee)
    } else if (paymentDetail.sendingWalletDescriptor.currency === WalletCurrency.Btc) {
      const getBreezFee = async (): Promise<void> => {
        try {
          const rawBreezFee = await fetchReverseSwapFeesBreezSDK({
            sendAmountSat: settlementAmount.amount * 100,
          })
          const formattedBreezFee: FeeType = {
            amount: {
              amount: rawBreezFee.feesClaim,
              currency: "BTC",
              currencyCode: "BTC",
            },
            status: "set",
          }
          setFee(formattedBreezFee)
        } catch (err) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        }
      }
      // This ensures that getBreezFee is only called when the component mounts
      getBreezFee()
    } else {
      setFee(getLightningFee)
    }
  }, [
    getLightningFee,
    paymentDetail.paymentType,
    paymentDetail.sendingWalletDescriptor.currency,
    settlementAmount.amount,
  ])

  const {
    loading: sendPaymentLoading,
    sendPayment,
    hasAttemptedSend,
  } = useSendPayment(sendPaymentMutation, destination, settlementAmount, note)

  let feeDisplayText = ""
  if (fee.amount) {
    const feeDisplayAmount = paymentDetail.convertMoneyAmount(fee.amount, DisplayCurrency)
    feeDisplayText = formatDisplayAndWalletAmount({
      displayAmount: feeDisplayAmount,
      walletAmount: fee.amount,
    })
  } else {
    feeDisplayText = "Unable to calculate fee"
  }

  const handleSendPayment = useMemo(() => {
    if (!sendPayment || !sendingWalletDescriptor?.currency) {
      return sendPayment
    }

    return async () => {
      try {
        logPaymentAttempt({
          paymentType: paymentDetail.paymentType,
          sendingWallet: sendingWalletDescriptor.currency,
        })
        const { status, errorsMessage } = await sendPayment()
        logPaymentResult({
          paymentType: paymentDetail.paymentType,
          paymentStatus: status,
          sendingWallet: sendingWalletDescriptor.currency,
        })

        if (status === "SUCCESS" || status === "PENDING") {
          navigation.dispatch((state) => {
            const routes = [{ name: "Primary" }, { name: "sendBitcoinSuccess" }]
            return CommonActions.reset({
              ...state,
              routes,
              index: routes.length - 1,
            })
          })
          ReactNativeHapticFeedback.trigger("notificationSuccess", {
            ignoreAndroidSystemSettings: true,
          })
          return
        }

        if (status === "ALREADY_PAID") {
          setPaymentError("Invoice is already paid")
          ReactNativeHapticFeedback.trigger("notificationError", {
            ignoreAndroidSystemSettings: true,
          })
          return
        }

        setPaymentError(errorsMessage || "Something went wrong")
        ReactNativeHapticFeedback.trigger("notificationError", {
          ignoreAndroidSystemSettings: true,
        })
      } catch (err) {
        if (err instanceof Error) {
          crashlytics().recordError(err)
          setPaymentError(err.message || err.toString())
        }
      }
    }
  }, [
    navigation,
    paymentDetail.paymentType,
    sendPayment,
    setPaymentError,
    sendingWalletDescriptor?.currency,
  ])

  let validAmount = true
  let invalidAmountErrorMessage = ""

  if (
    moneyAmountIsCurrencyType(settlementAmount, WalletCurrency.Btc) &&
    btcBalanceMoneyAmount &&
    !isSendingMax
  ) {
    const totalAmount = addMoneyAmounts({
      a: settlementAmount,
      b: fee.amount || ZeroBtcMoneyAmount,
    })
    validAmount = lessThanOrEqualTo({
      value: totalAmount,
      lessThanOrEqualTo: btcBalanceMoneyAmount,
    })
    if (!validAmount) {
      invalidAmountErrorMessage = LL.SendBitcoinScreen.amountExceed({
        balance: btcWalletText,
      })
    }
  }

  if (
    moneyAmountIsCurrencyType(settlementAmount, WalletCurrency.Usd) &&
    usdBalanceMoneyAmount &&
    !isSendingMax
  ) {
    const totalAmount = addMoneyAmounts({
      a: settlementAmount,
      b: fee.amount || ZeroUsdMoneyAmount,
    })
    validAmount = lessThanOrEqualTo({
      value: totalAmount,
      lessThanOrEqualTo: usdBalanceMoneyAmount,
    })
    if (!validAmount) {
      invalidAmountErrorMessage = LL.SendBitcoinScreen.amountExceed({
        balance: usdWalletText,
      })
    }
  }

  const errorMessage = paymentError || invalidAmountErrorMessage

  return (
    <Screen preset="scroll" style={styles.screenStyle} keyboardOffset="navigationHeader">
      <View style={styles.sendBitcoinConfirmationContainer}>
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldTitleText}>{LL.SendBitcoinScreen.destination()}</Text>
          <View style={styles.fieldBackground}>
            <View style={styles.destinationIconContainer}>
              <DestinationIcon fill={colors.black} />
            </View>
            <PaymentDestinationDisplay
              destination={destination}
              paymentType={paymentType}
            />
          </View>
        </View>
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldTitleText}>{LL.SendBitcoinScreen.amount()}</Text>
          <AmountInput
            unitOfAccountAmount={unitOfAccountAmount}
            canSetAmount={false}
            isSendingMax={paymentDetail.isSendingMax}
            convertMoneyAmount={convertMoneyAmount}
            walletCurrency={sendingWalletDescriptor.currency}
          />
        </View>
        {note ? (
          <View style={styles.fieldContainer}>
            <Text style={styles.fieldTitleText}>{LL.SendBitcoinScreen.note()}</Text>
            <View style={styles.fieldBackground}>
              <View style={styles.noteIconContainer}>
                <NoteIcon style={styles.noteIcon} />
              </View>
              <Text>{note}</Text>
            </View>
          </View>
        ) : null}
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldTitleText}>{LL.common.from()}</Text>
          <View style={styles.fieldBackground}>
            <View style={styles.walletSelectorTypeContainer}>
              <View
                style={
                  sendingWalletDescriptor.currency === WalletCurrency.Btc
                    ? styles.walletSelectorTypeLabelBitcoin
                    : styles.walletSelectorTypeLabelUsd
                }
              >
                {sendingWalletDescriptor.currency === WalletCurrency.Btc ? (
                  <Text style={styles.walletSelectorTypeLabelBtcText}>BTC</Text>
                ) : (
                  <Text style={styles.walletSelectorTypeLabelUsdText}>USD</Text>
                )}
              </View>
            </View>
            <View style={styles.walletSelectorInfoContainer}>
              <View style={styles.walletSelectorTypeTextContainer}>
                {sendingWalletDescriptor.currency === WalletCurrency.Btc ? (
                  <Text style={styles.walletCurrencyText}>{LL.common.btcAccount()}</Text>
                ) : (
                  <Text style={styles.walletCurrencyText}>{LL.common.usdAccount()}</Text>
                )}
              </View>
              <View style={styles.walletSelectorBalanceContainer}>
                {sendingWalletDescriptor.currency === WalletCurrency.Btc ? (
                  <Text>{btcWalletText}</Text>
                ) : (
                  <Text>{usdWalletText}</Text>
                )}
              </View>
              <View />
            </View>
          </View>
        </View>
        <View style={styles.fieldContainer}>
          <Text style={styles.fieldTitleText}>
            {LL.SendBitcoinConfirmationScreen.feeLabel()}
          </Text>
          <View style={styles.fieldBackground}>
            {fee.status === "loading" && <ActivityIndicator />}
            {fee.status === "set" && (
              <Text {...testProps("Successful Fee")}>{feeDisplayText}</Text>
            )}
            {fee.status === "error" && Boolean(fee.amount) && (
              <Text>{feeDisplayText} *</Text>
            )}
            {fee.status === "error" && !fee.amount && (
              <Text>{LL.SendBitcoinConfirmationScreen.feeError()}</Text>
            )}
          </View>
          {fee.status === "error" && Boolean(fee.amount) && (
            <Text style={styles.maxFeeWarningText}>
              {"*" + LL.SendBitcoinConfirmationScreen.maxFeeSelected()}
            </Text>
          )}
        </View>

        {errorMessage ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        ) : null}
        <View style={styles.buttonContainer}>
          <GaloyPrimaryButton
            loading={sendPaymentLoading}
            title={LL.SendBitcoinConfirmationScreen.title()}
            disabled={!handleSendPayment || !validAmount || hasAttemptedSend}
            onPress={handleSendPayment || undefined}
          />
        </View>
      </View>
    </Screen>
  )
}

export default SendBitcoinConfirmationScreen

const useStyles = makeStyles(({ colors }) => ({
  sendBitcoinConfirmationContainer: {
    flex: 1,
  },
  fieldContainer: {
    marginBottom: 12,
  },
  fieldBackground: {
    flexDirection: "row",
    borderStyle: "solid",
    overflow: "hidden",
    backgroundColor: colors.grey5,
    paddingHorizontal: 14,
    borderRadius: 10,
    alignItems: "center",
    height: 60,
  },
  fieldTitleText: {
    fontWeight: "bold",
    marginBottom: 4,
  },
  destinationIconContainer: {
    justifyContent: "center",
    alignItems: "center",
    marginRight: 12,
  },
  walletSelectorTypeContainer: {
    justifyContent: "center",
    alignItems: "flex-start",
    width: 50,
    marginRight: 20,
  },
  walletSelectorTypeLabelBitcoin: {
    height: 30,
    width: 50,
    borderRadius: 10,
    backgroundColor: colors.primary,
    justifyContent: "center",
    alignItems: "center",
  },
  walletSelectorTypeLabelUsd: {
    height: 30,
    width: 50,
    backgroundColor: colors.green,
    borderRadius: 10,
    justifyContent: "center",
    alignItems: "center",
  },
  walletSelectorTypeLabelUsdText: {
    fontWeight: "bold",
    color: colors.black,
  },
  walletSelectorTypeLabelBtcText: {
    fontWeight: "bold",
    color: colors.white,
  },
  walletSelectorInfoContainer: {
    flex: 1,
    flexDirection: "column",
  },
  walletSelectorTypeTextContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  walletCurrencyText: {
    fontWeight: "bold",
    fontSize: 18,
  },
  walletSelectorBalanceContainer: {
    flex: 1,
    flexDirection: "row",
  },
  buttonContainer: {
    flex: 1,
    justifyContent: "flex-end",
  },
  errorContainer: {
    marginVertical: 20,
    flex: 1,
  },
  errorText: {
    color: colors.error,
    textAlign: "center",
  },
  maxFeeWarningText: {
    color: colors.warning,
    fontWeight: "bold",
  },
  noteIconContainer: {
    marginRight: 12,
    justifyContent: "center",
    alignItems: "flex-start",
  },
  noteIcon: {
    justifyContent: "center",
    alignItems: "center",
  },
  screenStyle: {
    padding: 20,
    flexGrow: 1,
  },
}))
